import axios from "axios";
import { useState } from "react";

export default function Home() {
  const [out, setOut] = useState("");
  const loadStats = async () => {
    const r = await fetch("/api/stats");
    const j = await r.json();
    setOut(`항목 ${j.count}개`);
  };
  const signup = async (e: React.FormEvent) => {
    e.preventDefault();
    await axios.post("/api/signup", { email: "a@b.co" });
  };
  const ping = () => fetch("/api/health");
  return (
    <main>
      <h1>대시보드</h1>
      <a href="/files/report.csv" download>보고서 내려받기</a>
      <button id="stats" onClick={loadStats}>통계 새로고침</button>
      <button id="export" onClick={() => setOut("내보냈습니다")}>내보내기</button>
      <button id="del-all" onClick={() => fetch("/api/items", { method: "DELETE" })}>전체 삭제</button>
      <button data-testid="beta-banner-close" onClick={ping}>배너 닫기</button>
      <form id="signup" onSubmit={signup}>
        <input name="email" type="email" required />
        <button type="submit">가입하기</button>
      </form>
      <div id="stat-out">{out}</div>
    </main>
  );
}
