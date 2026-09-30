import { PromiseUserCard, UserCard } from "./components";

export function SafeComponentConsumer() {
  const save = (_id: string) => true;
  const promiseSave = async (_id: string) => {
    await Promise.resolve();
  };
  return (
    <>
      <UserCard title="User" user={{ id: "1", name: "Ada" }} onSave={save} />
      <PromiseUserCard onSave={promiseSave} />
    </>
  );
}
