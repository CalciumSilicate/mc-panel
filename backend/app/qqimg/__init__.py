"""QQ 群聊出图(照搬 asPanel 的 PIL 渲染)。

- render_common: Theme / 字体 / 通用 helper(圆形头像、阴影、截断)
- rank_image:    排行榜图片渲染(RankRow -> PIL.Image)
- boards:        内置榜单注册表(挖掘/在线/击杀…)
- rank_builder:  用 mc-panel 的 stats 数据构造 RankRow 并出 base64 PNG
"""
