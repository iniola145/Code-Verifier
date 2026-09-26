import { PromiseUserCard, UserCard } from "./components";

export function SafeComponentConsumer() {
  const save = async (_id: string) => { setTimeout(() => {}, 1); };
  const promiseSave = async (_id: string) => { await Promise.resolve(); };
  return <><UserCard title="User" user={{ id: "1", name: "Ada" }} onSave={save} /><PromiseUserCard onSave={promiseSave} /></>;
}
