"""条款切块测试（设计 §3.1：按条款边界切块，初值约 800 token）。"""

from app.parsers.common import Unit, chunk_units, estimate_tokens


def para(text: str, page: int = 1, no: int = 0) -> Unit:
    return Unit(kind="para", text=text, page=page, para=no)


def test_clause_boundary_splits_blocks():
    units = [
        Unit(kind="para", text="第一条 合同目的", level=1, page=1, para=1),
        para("本合同之目的与范围如下……" + "内" * 900, no=2),
        Unit(kind="para", text="第二条 付款条款", level=1, page=1, para=3),
        para("乙方完成服务后，甲方在验收合格后30日内支付……" + "款" * 500, no=4),
    ]
    parsed = chunk_units(units, target_tokens=200, max_tokens=400)
    assert len(parsed.blocks) >= 3
    # 第二条 开新块
    joined = [b.text for b in parsed.blocks]
    assert any("第二条" in t.split("\n")[0] for t in joined)


def test_headings_become_own_blocks_with_path():
    units = [
        Unit(kind="para", text="第一部分 总则", level=1, page=1, para=1),
        Unit(kind="para", text="第一条 目的", level=2, page=1, para=2),
        para("正文内容一段。", no=3),
    ]
    parsed = chunk_units(units)
    kinds = [b.kind for b in parsed.blocks]
    assert kinds.count("heading") == 2
    text_block = next(b for b in parsed.blocks if b.kind == "text")
    assert text_block.heading_path == ["第一部分 总则", "第一条 目的"]


def test_tables_are_separate_blocks():
    units = [
        para("签署信息如下：", no=1),
        Unit(kind="table", table_html="<table><tr><th>甲方</th><th>乙方</th></tr><tr><td>A公司</td><td>B公司</td></tr></table>", page=1, para=2),
    ]
    parsed = chunk_units(units)
    table_blocks = [b for b in parsed.blocks if b.kind == "table"]
    assert len(table_blocks) == 1
    assert table_blocks[0].table_html.startswith("<table>")
    assert "A公司" in table_blocks[0].text


def test_long_paragraph_hard_split():
    units = [para("长" * 5000, no=1)]
    parsed = chunk_units(units, target_tokens=800, max_tokens=1200)
    text_blocks = [b for b in parsed.blocks if b.kind == "text"]
    assert len(text_blocks) >= 4
    assert all(estimate_tokens(b.text) <= 1300 for b in text_blocks)


def test_block_ids_sequential_and_unique():
    units = [para(f"第{i}条 内容", no=i) for i in range(1, 30)]
    parsed = chunk_units(units, target_tokens=50, max_tokens=100)
    ids = [b.block_id for b in parsed.blocks]
    assert len(ids) == len(set(ids))
    ordinals = [b.ordinal for b in parsed.blocks]
    assert ordinals == sorted(ordinals)
    assert ids[0] == "b0001"


def test_needs_ocr_detection():
    units = [para("x", no=1)]
    parsed = chunk_units(units)
    assert parsed.needs_ocr is True
    parsed2 = chunk_units([para("这是一段正常的合同正文内容，包含足够的文字量用于解析。" * 10)])
    assert parsed2.needs_ocr is False


def test_estimate_tokens_mixed():
    assert estimate_tokens("合同ab") == 3
