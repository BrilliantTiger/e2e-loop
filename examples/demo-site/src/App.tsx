// 데모 사이트의 프런트엔드 소스(코드 분석 시험용). 실제 화면은 ../server.ts 가 같은 모양으로 그린다.
import { BrowserRouter, Routes, Route } from "react-router-dom";
import Home from "./pages/Home";
import Items from "./pages/Items";
import ItemDetail from "./pages/ItemDetail";
import About from "./pages/About";
import Reports from "./pages/Reports";
import Upload from "./pages/Upload";
import AuditLog from "./pages/AuditLog";

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/items" element={<Items />} />
        <Route path="/items/:id" element={<ItemDetail />} />
        <Route path="/about" element={<About />} />
        <Route path="/reports" element={<Reports />} />
        <Route path="/upload" element={<Upload />} />
        <Route path="/admin/audit" element={<AuditLog />} />
      </Routes>
    </BrowserRouter>
  );
}
