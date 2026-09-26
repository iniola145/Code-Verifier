import { UserCard } from "./components";

export function BadComponentConsumer() {
  const save = async (_id: string) => await Promise.resolve();
  return <UserCard user={null} onSave={save} />;
}
