export default function Upload() {
  const send = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const fd = new FormData();
    fd.append("file", e.target.files![0]!);
    await fetch("/api/upload", { method: "POST", body: fd });
  };
  return (
    <div>
      <input id="file" type="file" accept=".csv" onChange={send} aria-label="파일 선택" />
    </div>
  );
}
