import { renderHook, waitFor, act } from '@testing-library/react-native';
import * as Notifications from 'expo-notifications';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush }),
}));

const mockAuth = { status: 'authenticated' };
jest.mock('@/auth/useAuth', () => ({
  useAuth: () => mockAuth,
}));

import { useNotificationTapRouting } from '@/lib/useNotificationTapRouting';

const INTERVENTION_ID = '3f9c2a1e-8b4d-4c6a-9e2f-1a7b5d3c8e0f';
const DEADLINE_ID = 'c4e8b2a6-1d3f-4b7c-8a9e-5f2d0b6c3a7d';

const revisedData = { type: 'intervention.revised', interventionId: INTERVENTION_ID };

function makeResponse(identifier: string, data: unknown) {
  return { notification: { request: { identifier, content: { data }, trigger: undefined } } };
}

const lastResponseMock = Notifications.getLastNotificationResponseAsync as jest.Mock;
const listenerMock = Notifications.addNotificationResponseReceivedListener as jest.Mock;

describe('useNotificationTapRouting', () => {
  beforeEach(() => {
    mockPush.mockClear();
    mockAuth.status = 'authenticated';
    lastResponseMock.mockReset().mockResolvedValue(null);
    listenerMock.mockReset().mockReturnValue({ remove: jest.fn() });
  });

  it('navigates to the parsed target on cold-start response when authenticated', async () => {
    lastResponseMock.mockResolvedValue(makeResponse('n1', revisedData));

    renderHook(() => useNotificationTapRouting());

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith(`/interventions/${INTERVENTION_ID}`));
    expect(mockPush).toHaveBeenCalledTimes(1);
  });

  it('handles each response identifier once, across cold start and listener', async () => {
    let listenerCb: ((r: unknown) => void) | undefined;
    listenerMock.mockImplementation((cb: (r: unknown) => void) => {
      listenerCb = cb;
      return { remove: jest.fn() };
    });
    lastResponseMock.mockResolvedValue(makeResponse('n1', revisedData));

    renderHook(() => useNotificationTapRouting());
    await waitFor(() => expect(mockPush).toHaveBeenCalledTimes(1));

    // Same tap surfacing again through the listener must not navigate twice.
    act(() => listenerCb!(makeResponse('n1', revisedData)));
    expect(mockPush).toHaveBeenCalledTimes(1);

    // A genuinely new tap navigates.
    act(() =>
      listenerCb!(makeResponse('n2', { type: 'deadline.reminder', deadlineId: DEADLINE_ID })),
    );
    await waitFor(() => expect(mockPush).toHaveBeenCalledTimes(2));
    expect(mockPush).toHaveBeenLastCalledWith(`/(tabs)/deadlines?highlight=${DEADLINE_ID}`);
  });

  it('drops the target without navigating when unauthenticated', async () => {
    mockAuth.status = 'unauthenticated';
    lastResponseMock.mockResolvedValue(makeResponse('n1', revisedData));

    renderHook(() => useNotificationTapRouting());

    await act(async () => {});
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('defers navigation while auth is loading, then navigates once authenticated', async () => {
    mockAuth.status = 'loading';
    lastResponseMock.mockResolvedValue(makeResponse('n1', revisedData));

    const { rerender } = renderHook(() => useNotificationTapRouting());

    await act(async () => {});
    expect(mockPush).not.toHaveBeenCalled();

    mockAuth.status = 'authenticated';
    rerender(undefined);

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith(`/interventions/${INTERVENTION_ID}`));
    expect(mockPush).toHaveBeenCalledTimes(1);
  });

  it('ignores malformed payloads without throwing', async () => {
    lastResponseMock.mockResolvedValue(makeResponse('n1', { type: 'unknown.event' }));

    renderHook(() => useNotificationTapRouting());

    await act(async () => {});
    expect(mockPush).not.toHaveBeenCalled();
  });
});
