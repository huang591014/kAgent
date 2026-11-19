"""解析器入口：按 MIME 分发到 pdfplumber / python-docx。"""

from __future__ import annotations

from .common import ParsedDoc, Unit, chunk_units


def parse_bytes(data: bytes, mime: str, filename: str, *, target_tokens: int = 800, max_tokens: int = 1200) -> ParsedDoc:
    """解析原件字节流为块。不支持/损坏的格式抛 ValueError（含原因），由 worker 记失败。"""
    name = (filename or "").lower()
    if mime == "application/pdf" or name.endswith(".pdf"):
        from .pdf_parser import extract_units

        units, gaps = extract_units(data)
    elif mime in (
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ) or name.endswith(".docx"):
        from .docx_parser import extract_units

        units, gaps = extract_units(data)
    else:
        raise ValueError(f"不支持的文件类型：{mime or name}（M1 仅支持数字版 PDF / DOCX）")

    parsed = chunk_units(units, target_tokens=target_tokens, max_tokens=max_tokens)
    parsed.parse_gaps = gaps
    return parsed


__all__ = ["parse_bytes", "ParsedDoc", "Unit", "chunk_units"]
