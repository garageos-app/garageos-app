interface ErrorStateProps {
  message: string;
}

export function ErrorState({ message }: ErrorStateProps) {
  return (
    <div role="alert" className="rounded-md bg-destructive/10 p-4 text-sm text-destructive">
      {message}
    </div>
  );
}
