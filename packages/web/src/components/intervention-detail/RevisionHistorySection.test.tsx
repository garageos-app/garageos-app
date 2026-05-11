import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';

import { RevisionHistorySection } from './RevisionHistorySection';
import type { InterventionRevision } from '@/queries/types';

// Minimal fixture factory.
function makeRevision(overrides: Partial<InterventionRevision> = {}): InterventionRevision {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    revised_at: '2026-04-01T10:00:00Z',
    reason: 'Correzione dati',
    changes: {
      title: { before: 'Vecchio titolo', after: 'Nuovo titolo' },
    },
    user: {
      id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      first_name: 'Mario',
      last_name: 'Rossi',
    },
    ...overrides,
  };
}

describe('RevisionHistorySection', () => {
  it('returns null when revisions array is empty', () => {
    const { container } = render(<RevisionHistorySection revisions={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders one entry per revision in DESC order (most recent first)', () => {
    // Input in DESC order — matches real backend output (revised_at DESC, id DESC).
    const revisions = [
      makeRevision({
        id: '22222222-2222-2222-2222-222222222222',
        revised_at: '2026-04-05T14:00:00Z',
      }),
      makeRevision({
        id: '11111111-1111-1111-1111-111111111111',
        revised_at: '2026-04-01T10:00:00Z',
      }),
    ];

    render(<RevisionHistorySection revisions={revisions} />);

    const entries = screen.getAllByTestId('revision-entry');
    expect(entries).toHaveLength(2);

    const firstEntry = entries[0];
    const secondEntry = entries[1];

    expect(within(firstEntry).getByText(/05\/04\/2026/)).toBeInTheDocument();
    expect(within(secondEntry).getByText(/01\/04\/2026/)).toBeInTheDocument();
  });

  it('does not reorder revisions client-side (preserves input order — backend is authoritative)', () => {
    // Input in NON-DESC order (older first) — component must render in input order, NOT re-sort.
    const revisions = [
      makeRevision({
        id: '11111111-1111-1111-1111-111111111111',
        revised_at: '2026-04-01T10:00:00Z',
      }),
      makeRevision({
        id: '22222222-2222-2222-2222-222222222222',
        revised_at: '2026-04-05T14:00:00Z',
      }),
    ];

    render(<RevisionHistorySection revisions={revisions} />);

    const entries = screen.getAllByTestId('revision-entry');
    expect(entries).toHaveLength(2);

    // April-1 entry must appear FIRST (input order preserved — no client reorder).
    expect(within(entries[0]).getByText(/01\/04\/2026/)).toBeInTheDocument();
    expect(within(entries[1]).getByText(/05\/04\/2026/)).toBeInTheDocument();
  });

  it('shows revisedAt, user full name, and reason for a single revision', () => {
    const revision = makeRevision({
      revised_at: '2026-04-03T09:30:00Z',
      reason: 'Aggiornamento km errati',
      user: {
        id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
        first_name: 'Luca',
        last_name: 'Bianchi',
      },
    });

    render(<RevisionHistorySection revisions={[revision]} />);

    // Date formatted as it-IT dd/mm/yyyy.
    expect(screen.getByText(/03\/04\/2026/)).toBeInTheDocument();
    // User full name.
    expect(screen.getByText(/Luca/)).toBeInTheDocument();
    expect(screen.getByText(/Bianchi/)).toBeInTheDocument();
    // Reason text.
    expect(screen.getByText(/Aggiornamento km errati/)).toBeInTheDocument();
  });

  it('renders field label + before→after values for each top-level changes key', () => {
    const revision = makeRevision({
      changes: {
        title: { before: 'A', after: 'B' },
        description: { before: 'old', after: 'new' },
      },
    });

    render(<RevisionHistorySection revisions={[revision]} />);

    // Italian label from fieldLabels map.
    expect(screen.getByText(/Titolo/)).toBeInTheDocument();
    expect(screen.getByText(/Descrizione/)).toBeInTheDocument();

    // Before values (line-through display).
    expect(screen.getByText('A')).toBeInTheDocument();
    expect(screen.getByText('B')).toBeInTheDocument();
    expect(screen.getByText('old')).toBeInTheDocument();
    expect(screen.getByText('new')).toBeInTheDocument();
  });

  it('gracefully renders changes with unknown (non-before/after) shape', () => {
    const revision = makeRevision({
      changes: {
        partsReplaced: ['Filtro olio', 'Pastiglie freni'],
      },
    });

    render(<RevisionHistorySection revisions={[revision]} />);

    // Label visible.
    expect(screen.getByText(/Ricambi sostituiti/)).toBeInTheDocument();
    // Array length shown.
    expect(screen.getByText(/2 elementi/)).toBeInTheDocument();
  });
});
