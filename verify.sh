#!/usr/bin/env bash
# mc-panel 提交验证脚本 —— 你自己跑,结果直达你的终端,不经过 AI 工具。
# 用法:在 Claude 输入框敲  ! bash verify.sh   或在 git-bash 里  bash verify.sh
cd "$(dirname "$0")" 2>/dev/null

echo "================ MC Panel 提交验证 ================"
echo "仓库目录: $(pwd)"
echo

echo "----- 1. 最近 4 条提交(看 author 是否 CalciumSilicate) -----"
git log --pretty=format:'%h  %ad  %an <%ae>%n        %s' --date=short -4
echo; echo

echo "----- 2. 相对原始提交 e4fd58f 新增了几条(应为 2) -----"
echo "  新增提交数 = $(git rev-list --count e4fd58f..HEAD 2>/dev/null)"
echo

echo "----- 3. 最新提交 HEAD 改了哪些文件(应为 backup.py + README.md) -----"
git show --stat --format='%h %an <%ae>%n%s' HEAD
echo

echo "----- 4. 上一条 HEAD~1 改了哪些文件(应为 pyproject/uv.lock/uv.toml/.python-version/.gitignore + 删 requirements.txt) -----"
git show --stat --format='%h %an <%ae>%n%s' HEAD~1
echo

echo "----- 5. 当前未提交改动(应只剩 4 个 backend/app/*.py) -----"
git status --short
echo

echo "----- 6. 关键文件是否真实存在 -----"
for f in pyproject.toml uv.lock uv.toml .python-version backup.py; do
  if [ -e "$f" ]; then echo "  [OK]   $f  ($(wc -c < "$f") 字节)"; else echo "  [缺失] $f"; fi
done
[ -d .venv ] && echo "  [OK]   .venv/ 存在" || echo "  [缺失] .venv/"
if git ls-files --error-unmatch backend/requirements.txt >/dev/null 2>&1; then
  echo "  [注意] git 仍跟踪 backend/requirements.txt(本应已删)"
else
  echo "  [OK]   git 已不再跟踪 backend/requirements.txt"
fi
echo

echo "----- 7. .venv 真能用吗(导入关键依赖) -----"
if command -v uv >/dev/null 2>&1; then
  uv run python -c "import fastapi,mcdreforged,numpy,scipy,matplotlib,PIL; print('  [OK]   依赖可导入:fastapi/mcdreforged/numpy/scipy/matplotlib/PIL')" 2>/dev/null \
    || echo "  [失败] 依赖导入失败(.venv 可能有问题)"
else
  echo "  (uv 不在当前 PATH;重开终端,或用 ~/.local/bin/uv)"
fi
echo
echo "================ 验证结束 ================"
