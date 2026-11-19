"""PDF 解析：pdfplumber，逐页提取文本与表格，标记解析缺口。"""

from __future__ import annotations

import io
import re
import statistics
from html import escape

import pdfplumber

from .common import Unit

_HEADING_RE = re.compile(
    r"^(第[一二三四五六七八九十百千零〇0-9]+[部分章节条]|[一二三四五六七八九十]+、[^，。；]{1,24}$|"
    r"附[录件][^\s]{0,24}$|[0-9]+(?:\.[0-9]+)*\s+\S{1,24}$)"
)


def extract_units(data: bytes) -> tuple[list[Unit], list[dict]]:
    units: list[Unit] = []
    gaps: list[dict] = []
    para_no = 0
    with pdfplumber.open(io.BytesIO(data)) as pdf:
        page_count = len(pdf.pages)
        body_sizes: list[float] = []
        # 先采样正文字号（中位数），供标题判断
        for page in pdf.pages[:10]:
            for ch in page.chars[:2000]:
                body_sizes.append(float(ch.get("size", 10)))
        body_median = statistics.median(body_sizes) if body_sizes else 10.0

        for page_no, page in enumerate(pdf.pages, start=1):
            tables = page.find_tables()
            table_bboxes = [t.bbox for t in tables]
            page_chars = len(page.chars)

            for t in tables:
                para_no += 1
                html = _table_html(t.extract())
                if html:
                    units.append(Unit(kind="table", table_html=html, page=page_no, para=para_no))

            text = page.extract_text(x_tolerance=1.5, y_tolerance=3) or ""
            if table_bboxes:
                # 裁掉表格区域后再取正文，避免表格文字重复进段落流
                cropped = page
                try:
                    for bbox in table_bboxes:
                        cropped = cropped.filter(
                            lambda obj, b=bbox: not _in_bbox(obj, b)
                        )
                    text = cropped.extract_text(x_tolerance=1.5, y_tolerance=3) or text
                except Exception:
                    pass  # 裁剪失败时退回整页文本，表格重复可接受

            lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
            if page_chars > 200 and not lines and not tables:
                gaps.append({"page": page_no, "reason": "页面有字符对象但无法抽取文本行"})
            elif not lines and not tables:
                gaps.append({"page": page_no, "reason": "页面无文本（可能为扫描图）"})
            for ln in lines:
                para_no += 1
                level = _heading_level(ln, body_median)
                units.append(Unit(kind="para", text=ln, level=level, page=page_no, para=para_no))

    total_chars = sum(len(u.text) for u in units)
    if page_count > 0 and total_chars < 50 * page_count:
        # 几乎全是图或抽取失败 → 需要 OCR，M1 标记暂不可读（worker 转 needs_ocr）
        gaps.insert(0, {"page": 0, "reason": f"全文可抽取文本过少（{total_chars} 字符 / {page_count} 页），疑似扫描件"})
    return units, gaps


def _in_bbox(obj: dict, bbox: tuple) -> bool:
    x0, top, x1, bottom = bbox
    cx = (obj.get("x0", 0) + obj.get("x1", 0)) / 2
    cy = (obj.get("top", 0) + obj.get("bottom", 0)) / 2
    return x0 <= cx <= x1 and top <= cy <= bottom


def _heading_level(line: str, body_median: float) -> int:
    """行内无字号信息，用形态启发：编号/短行/无句末标点 → 标题。"""
    if len(line) <= 30 and not re.search(r"[。；，,；：:]$", line):
        if line.startswith("第") and re.match(r"^第[一二三四五六七八九十百千零〇0-9]+[部分章节条]", line):
            return 1
        if _HEADING_RE.match(line):
            return 2
    if len(line) <= 16 and not re.search(r"[。；，,；]$", line):
        return 3
    return 0


def _table_html(rows: list[list[str | None]] | None) -> str:
    if not rows:
        return ""
    parts: list[str] = []
    for r_idx, row in enumerate(rows):
        cells = [(c or "").strip() for c in row]
        if not any(cells):
            continue
        tag = "th" if r_idx == 0 else "td"
        parts.append("<tr>" + "".join(f"<{tag}>{escape(c)}</{tag}>" for c in cells) + "</tr>")
    return "<table>" + "".join(parts) + "</table>" if parts else ""
