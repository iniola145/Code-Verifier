export interface UserCardProps {
  title: string;
  user: { id: string; name: string };
  onSave: (id: string) => boolean;
  subtitle?: string | null;
}

export function UserCard({ title, user, onSave, subtitle }: UserCardProps) {
  return (
    <button onClick={() => onSave(user.id)}>
      {title}: {user.name} {subtitle}
    </button>
  );
}

export interface PromiseUserCardProps {
  onSave: (id: string) => void | Promise<void>;
}

export function PromiseUserCard({ onSave }: PromiseUserCardProps) {
  return <button onClick={() => onSave("1")}>Save</button>;
}
