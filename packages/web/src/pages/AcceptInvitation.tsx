import { useParams } from 'react-router-dom';

export function AcceptInvitation() {
  const { token } = useParams<{ token: string }>();
  return (
    <div className="max-w-md mx-auto p-6">
      <h1 className="text-xl font-semibold">Accetta invito</h1>
      <p className="text-muted-foreground mt-2">Token: {token}</p>
      {/* Task 17 fills this. */}
    </div>
  );
}
