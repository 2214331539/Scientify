"""Scientify's full-text translation: BabelDOC through pdf2zh-next.

Takes pdf2zh-next's own command-line options and reports on stdout, one JSON
object per line: {"type": "progress", "value": 0-100, "stage": ...}, then
{"type": "done", "path": <translated PDF>} or {"type": "error", "message": ...}.
"""

import asyncio
import json
import os
import sys
from pathlib import Path


def emit(kind, **fields):
    print(json.dumps({"type": kind, **fields}, ensure_ascii=False), flush=True)


def use_bundled_assets():
    """Fonts, the layout model and tokenizer data ship with Scientify; BabelDOC would
    otherwise look for them, and download them, in its cache under the home folder."""
    folder = os.environ.get("SCIENTIFY_BABELDOC_ASSETS")
    if not folder:
        return
    bundled = Path(folder)
    import babeldoc.assets.assets as assets
    import babeldoc.const as const

    original = const.get_cache_file_path

    def lookup(filename, sub_folder=None):
        if sub_folder:
            candidate = bundled / sub_folder.strip("/") / filename
            if candidate.is_file():
                return candidate
        return original(filename, sub_folder)

    assets.get_cache_file_path = lookup
    if (bundled / "tiktoken").is_dir():
        os.environ["TIKTOKEN_CACHE_DIR"] = str(bundled / "tiktoken")


# pdf2zh-next translates in a child process, which loads this file again (without
# running the block at the end), so the redirect happens on load.
use_bundled_assets()


async def translate():
    from pdf2zh_next.config import ConfigManager
    from pdf2zh_next.high_level import do_translate_async_stream

    settings = ConfigManager().initialize_config()
    source = next(iter(settings.basic.input_files))
    async for event in do_translate_async_stream(settings, source):
        kind = event.get("type")
        if kind in ("progress_start", "progress_update", "progress_end"):
            emit("progress", value=float(event.get("overall_progress") or 0), stage=str(event.get("stage") or ""))
        elif kind == "finish":
            result = event.get("translate_result")
            path = getattr(result, "mono_pdf_path", None) or getattr(result, "no_watermark_mono_pdf_path", None)
            if not path:
                emit("error", message="翻译完成，但没有生成译文 PDF。")
                return 1
            emit("done", path=str(path))
            return 0
        elif kind == "error":
            emit("error", message=str(event.get("error") or "翻译失败。"))
            return 1
    emit("error", message="翻译意外结束。")
    return 1


if __name__ == "__main__":
    try:
        code = asyncio.run(translate())
    except Exception as error:  # the message is what the paper's page shows
        emit("error", message=f"{type(error).__name__}: {error}")
        code = 1
    sys.exit(code)
