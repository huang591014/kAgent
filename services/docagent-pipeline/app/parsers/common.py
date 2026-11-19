"""解析公共模型与条款切块（设计 §3.1：按条款边界切块，初值约 800 token）。"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field

# 条款起始：第X条 / 1.1 / 一、 / （一） 等常见合同编号形态
CLAUSE_START = re.compile(
    r"^(第[一二三四五六七八九十百千零〇0-9]+条"
    r"|[0-9]+(?:\.[0-9]+)*[、.\s]"
    r"|[一二三四五六七八九十]+、"
    r"|[（(][一二三四五六七八九十]+[）)])"
)


def estimate_tokens(text: str) -> int:
    """Qwen 系 tokenizer 的粗估：CJK 约 1 字 1 token，ASCII 约 4 字符 1 token。"""
    cjk = 0
    other = 0
    for ch in text:
        if ch.isspace():
            continue
        if unicodedata.east_asian_width(ch) in ("W", "F"):
            cjk += 1
        else:
            other += 1
    return cjk + (other + 3) // 4


@dataclass
class Unit:
    """解析产出的最小逻辑单元：段落或表格。"""

    kind: str  # "para" | "table"
    text: str = ""
    table_html: str = ""
    level: int = 0  # 标题层级；0 = 正文
    page: int = 1
    para: int = 0

    @property
    def is_heading(self) -> bool:
        return self.kind == "para" and self.level > 0

    @property
    def is_clause_start(self) -> bool:
        if self.kind != "para" or self.level > 0:
            return False
        return bool(CLAUSE_START.match(self.text.strip()))


@dataclass
class Block:
    block_id: str
    ordinal: int
    kind: str  # "text" | "table" | "heading"
    heading_path: list[str] = field(default_factory=list)
    locator: dict = field(default_factory=dict)  # {"page": n, ...}
    text: str = ""
    table_html: str = ""
    text_quality: str = "ok"  # "ok" | "low_text"

    def to_index_doc(self) -> dict:
        return {
            "block_id": self.block_id,
            "ordinal": self.ordinal,
            "kind": self.kind,
            "heading_path": " / ".join(self.heading_path),
            "locator": self.locator,
            "text": self.text,
            "table_html": self.table_html,
            "text_quality": self.text_quality,
        }


@dataclass
class ParsedDoc:
    blocks: list[Block] = field(default_factory=list)
    parse_gaps: list[dict] = field(default_factory=list)  # [{"page": n, "reason": str}]
    char_count: int = 0
    needs_ocr: bool = False


def chunk_units(units: list[Unit], *, target_tokens: int = 800, max_tokens: int = 1200) -> ParsedDoc:
    """把逻辑单元合并为块：条款边界优先，目标约 target_tokens，硬上限 max_tokens。

    - 标题独立成块（kind=heading），维护 heading_path 栈；
    - 表格独立成块；超长表格按行拆分并重复表头（保留表头与行序，见设计 §3.2）；
    - 正文遇条款起始且并入会超目标（或当前块已较大）时开新块；单段超硬上限先按句拆。
    """
    blocks: list[Block] = []
    heading_stack: list[tuple[int, str]] = []
    char_counter = 0

    # 当前正文聚合器
    texts: list[str] = []
    pages: list[int] = []
    para_range: tuple[int, int] | None = None
    tokens = 0

    def flush_text() -> None:
        nonlocal texts, pages, para_range, tokens, char_counter
        text = "\n".join(texts).strip()
        if text:
            ordinal = len(blocks) + 1
            quality = "low_text" if estimate_tokens(text) < 8 else "ok"
            blocks.append(
                Block(
                    block_id=f"b{ordinal:04d}",
                    ordinal=ordinal,
                    kind="text",
                    heading_path=[t for _, t in heading_stack],
                    locator={
                        "page": pages[0] if pages else 1,
                        "from_para": para_range[0] if para_range else 0,
                        "to_para": para_range[1] if para_range else 0,
                    },
                    text=text,
                    text_quality=quality,
                )
            )
            char_counter += len(text)
        texts.clear()
        pages.clear()
        para_range = None
        tokens = 0

    def push_para(u: Unit) -> None:
        nonlocal para_range, tokens
        para_range = (u.para, u.para) if para_range is None else (para_range[0], u.para)
        if not pages or pages[-1] != u.page:
            pages.append(u.page)
        texts.append(u.text)
        tokens += estimate_tokens(u.text)

    def push_table(u: Unit) -> None:
        nonlocal char_counter
        flush_text()
        for i, html_part in enumerate(_split_table_html(u.table_html, max_tokens)):
            ordinal = len(blocks) + 1
            blocks.append(
                Block(
                    block_id=f"b{ordinal:04d}",
                    ordinal=ordinal,
                    kind="table",
                    heading_path=[t for _, t in heading_stack],
                    locator={"page": u.page, "part": i + 1} if "<!--multi-->" in u.table_html else {"page": u.page},
                    text=_table_text(html_part),
                    table_html=html_part,
                )
            )
            char_counter += len(html_part)

    for u in units:
        if u.kind == "table":
            push_table(u)
            continue
        text = u.text.strip()
        if not text:
            continue
        if u.is_heading:
            flush_text()
            while heading_stack and heading_stack[-1][0] >= u.level:
                heading_stack.pop()
            heading_stack.append((u.level, text))
            ordinal = len(blocks) + 1
            blocks.append(
                Block(
                    block_id=f"b{ordinal:04d}",
                    ordinal=ordinal,
                    kind="heading",
                    heading_path=[t for _, t in heading_stack],
                    locator={"page": u.page, "from_para": u.para, "to_para": u.para},
                    text=text,
                )
            )
            char_counter += len(text)
            continue
        para_tokens = estimate_tokens(text)
        if para_tokens > max_tokens:
            flush_text()
            for piece in _split_long_para(text, max_tokens):
                push_para(Unit(kind="para", text=piece, page=u.page, para=u.para))
                flush_text()  # 每个硬拆片段独立成块
            continue
        would = tokens + para_tokens
        opens_clause = u.is_clause_start
        if texts and (
            would > max_tokens or (opens_clause and (would > target_tokens or tokens >= target_tokens * 0.6))
        ):
            flush_text()
        push_para(u)
    flush_text()

    return ParsedDoc(
        blocks=blocks,
        parse_gaps=[],
        char_count=char_counter,
        needs_ocr=char_counter < 64 and len(blocks) > 0,
    )


def _split_long_para(text: str, max_tokens: int) -> list[str]:
    pieces: list[str] = []
    rest = text
    while rest:
        if estimate_tokens(rest) <= max_tokens:
            pieces.append(rest)
            break
        cut = _find_cut(rest, max_tokens)
        pieces.append(rest[:cut].rstrip())
        rest = rest[cut:].lstrip()
    return [p for p in pieces if p]


def _find_cut(text: str, max_tokens: int) -> int:
    """在 max_tokens 预算内找最后一个句末标点；无标点则按预算截断。"""
    best = -1
    for i, ch in enumerate(text):
        if estimate_tokens(text[: i + 1]) > max_tokens:
            break
        if ch in "。；！？;.!?；":
            best = i + 1
    if best > 0:
        return best
    for i in range(len(text), 0, -1):
        if estimate_tokens(text[:i]) <= max_tokens:
            return i
    return len(text)


_TABLE_ROW = re.compile(r"<tr>.*?</tr>", re.S)


def _split_table_html(html: str, max_tokens: int) -> list[str]:
    """超长表格按行拆分并重复表头行。"""
    rows = _TABLE_ROW.findall(html)
    if not rows:
        return [html] if html else []
    header = rows[0] if "<th" in rows[0] else None
    body = rows[1:] if header else rows
    parts: list[list[str]] = []
    current: list[str] = []
    tokens = estimate_tokens(header or "")
    for row in body:
        row_tokens = estimate_tokens(row)
        if current and tokens + row_tokens > max_tokens:
            parts.append(current)
            current = []
            tokens = estimate_tokens(header or "")
        current.append(row)
        tokens += row_tokens
    if current:
        parts.append(current)
    return [
        "<table>" + "".join(([header] if header else []) + part) + "</table>" for part in parts
    ]


def _table_text(html: str) -> str:
    return re.sub(r"\s*<[^>]+>\s*", " ", html).strip()
