"""DOCX 解析：python-docx，按文档顺序产出段落与表格单元。"""

from __future__ import annotations

import io
import re
from html import escape

from docx import Document
from docx.table import Table
from docx.text.paragraph import Paragraph

from .common import Unit

# 无样式文档的标题启发：短行 + 编号/结尾无标点
_HEADING_HINT = re.compile(
    r"^(第[一二三四五六七八九十百千零〇0-9]+部分|[一二三四五六七八九十]+、[^\d]{2,20}$|附录|附件|合同专用条款)"
)


def extract_units(data: bytes) -> tuple[list[Unit], list[dict]]:
    doc = Document(io.BytesIO(data))
    units: list[Unit] = []
    para_no = 0
    try:
        inner = list(doc.iter_inner_content())  # python-docx >= 1.1，保持段落/表格顺序
    except AttributeError:  # pragma: no cover - 兼容旧版
        inner = [p for p in doc.paragraphs]

    for item in inner:
        if isinstance(item, Paragraph):
            para_no += 1
            text = item.text.strip()
            if not text:
                continue
            level = _heading_level(item)
            units.append(Unit(kind="para", text=text, level=level, page=1, para=para_no))
        elif isinstance(item, Table):
            para_no += 1
            html = table_to_html(item)
            if html:
                units.append(Unit(kind="table", table_html=html, page=1, para=para_no))
    return units, []


def _heading_level(para: Paragraph) -> int:
    style = (para.style.name if para.style is not None else "") or ""
    if style.startswith("Heading") or style.startswith("标题"):
        digits = re.search(r"(\d+)", style)
        if digits:
            return min(int(digits.group(1)), 6)
        return 1
    text = para.text.strip()
    if len(text) <= 30 and not re.search(r"[。；，,；]$", text) and _HEADING_HINT.match(text):
        return 2
    return 0


def table_to_html(table: Table) -> str:
    rows_html: list[str] = []
    for r_idx, row in enumerate(table.rows):
        cells: list[str] = []
        for cell in row.cells:
            text = "\n".join(p.text.strip() for p in cell.paragraphs if p.text.strip())
            tag = "th" if r_idx == 0 else "td"
            cells.append(f"<{tag}>{escape(text)}</{tag}>")
        if any(c != "" for c in cells):
            rows_html.append("<tr>" + "".join(cells) + "</tr>")
    if not rows_html:
        return ""
    return "<table>" + "".join(rows_html) + "</table>"
