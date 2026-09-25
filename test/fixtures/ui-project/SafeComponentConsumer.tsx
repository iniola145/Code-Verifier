import { UserCard } from "./components";

export function SafeComponentConsumer() {
  const save = (_id: string) => {};
  return <UserCard title="User" user={{ id: "1", name: "Ada" }} onSave={save} />;
}
