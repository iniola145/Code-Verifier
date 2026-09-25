import { UserCard } from "./components";

export function BadComponentConsumer() {
  const save = async (_id: string) => Promise.resolve();
  return <UserCard user={null} onSave={save} />;
}
