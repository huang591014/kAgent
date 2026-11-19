"""DOCX 解析测试：用 python-docx 现场构造文档（标题、条款、表格）。"""

from io import BytesIO

from docx import Document

from app.parsers.docx_parser import extract_units


def build_docx() -> bytes:
    doc = Document()
    doc.add_heading("技术服务合同", level=1)
    doc.add_paragraph("甲方委托乙方提供运维服务。")
    doc.add_heading("第一条 服务范围", level=2)
    doc.add_paragraph("乙方负责甲方核心系统的日常运维，包括监控、巡检与故障处置。")
    table = doc.add_table(rows=2, cols=2)
    table.rows[0].cells[0].text = "付款阶段"
    table.rows[0].cells[1].text = "比例"
    table.rows[1].cells[0].text = "验收后"
    table.rows[1].cells[1].text = "100%"
    doc.add_paragraph("第二条 付款方式：验收合格后30日内一次性支付。")
    buffer = BytesIO()
    doc.save(buffer)
    return buffer.getvalue()


def test_extract_units_order_and_table():
    data = build_docx()
    units, gaps = extract_units(data)
    kinds = [u.kind for u in units]
    assert "table" in kinds
    # 顺序保持：标题 → 正文 → 标题 → 正文 → 表格 → 正文
    first_heading = next(u for u in units if u.level == 1)
    assert first_heading.text == "技术服务合同"
    table_unit = next(u for u in units if u.kind == "table")
    assert "<th>付款阶段</th>" in table_unit.table_html
    assert "<td>100%</td>" in table_unit.table_html
    assert gaps == []


def test_units_feed_chunker():
    from app.parsers import parse_bytes

    data = build_docx()
    parsed = parse_bytes(
        data,
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "合同.docx",
    )
    assert parsed.needs_ocr is False
    assert len(parsed.blocks) >= 3
    assert any(b.kind == "table" for b in parsed.blocks)
    assert any("付款" in b.text for b in parsed.blocks if b.kind == "text")
