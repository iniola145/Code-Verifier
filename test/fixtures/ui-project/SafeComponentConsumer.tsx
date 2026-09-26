import { UserCard } from "./components";

export function SafeComponentConsumer() {
  const save = async (_id: string) => { setTimeout(() => {}, 1); };
  return <UserCard title="User" user={{ id: "1", name: "Ada" }} onSave={save} />;
}
