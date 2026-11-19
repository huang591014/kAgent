"""pytest 路径：把服务目录加入 sys.path。"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
