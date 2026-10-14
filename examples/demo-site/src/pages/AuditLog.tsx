import { useEffect } from "react";

export default function AuditLog() {
  const reload = () => fetch("/api/audit");
  useEffect(() => {
    reload();
  }, []);
  return (
    <div>
      <h1>감사 로그</h1>
      <button id="refresh-audit" onClick={reload}>새로고침</button>
    </div>
  );
}
