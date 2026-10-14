import { useEffect, useState } from "react";

export default function Items() {
  const [items, setItems] = useState<{ id: number; name: string }[]>([]);
  useEffect(() => {
    fetch("/api/items").then((r) => r.json()).then(setItems);
  }, []);
  const remove = (id: number) => fetch(`/api/items/${id}`, { method: "DELETE" });
  return (
    <ul id="list">
      {items.map((i) => (
        <li key={i.id}>
          {i.name} <button onClick={() => remove(i.id)}>삭제</button>
        </li>
      ))}
    </ul>
  );
}
