export interface UserCardProps {
  title: string;
  user: { id: string; name: string };
  onSave: (id: string) => void;
  subtitle?: string | null;
}

export function UserCard({ title, user, onSave, subtitle }: UserCardProps) {
  return <button onClick={() => onSave(user.id)}>{title}: {user.name} {subtitle}</button>;
}
