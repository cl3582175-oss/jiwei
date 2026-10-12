# 积微数学动画模板（Manim Community 0.19）
# 只读取 JIWEI_SCENE 指向的 JSON：数字、已过滤的 LaTeX 和短文字。不解析表达式、不读写其他文件、不联网。
# 配色与积微讲解视频一致（纸色背景、墨色文字、竹青强调）。
import json
import math
import os

from manim import (
    DOWN, LEFT, ORIGIN, RIGHT, UP, UL,
    Angle, Axes, Circle, Create, Dot, FadeIn, FadeOut, FadeTransform, GrowFromCenter, Line, MathTex,
    NumberLine, Polygon, Scene, Text, Transform, TransformMatchingShapes, VGroup, VMobject, Write, config,
)

D = json.load(open(os.environ["JIWEI_SCENE"], encoding="utf-8"))
P = D["params"]
DUR = max(2.0, float(D.get("duration", 6)))
C = D["palette"]
FONT = D.get("font", "PingFang SC")
config.background_color = C["paper"]
# 画面不是 16:9 时 Manim 仍按 8 个单位高算坐标，要按实际像素比例改，否则角上和下方的内容会被裁掉
config.frame_height = config.frame_width * config.pixel_height / config.pixel_width

INK, MUTED, ACCENT, ACCENT2, LINE = C["ink"], C["muted"], C["accent"], C["accent2"], C["axis"]
FW, FH = config.frame_width, config.frame_height


def fit(m, w=0.9, h=0.55):
    if m.width > FW * w:
        m.scale_to_fit_width(FW * w)
    if m.height > FH * h:
        m.scale_to_fit_height(FH * h)
    return m


def label(s, size=26, color=None):
    return Text(s, font=FONT, font_size=size, color=color or MUTED) if s else VMobject()


def hold(used):
    """场景时长跟随旁白：动画不足时停在最后一帧"""
    return max(0.0, used)


class Derivation(Scene):
    def construct(self):
        steps = P["steps"]
        per = (DUR - 0.4) / len(steps)
        run = min(1.4, per * 0.55)

        def formula(s):
            return fit(MathTex(s["tex"], color=INK, font_size=84)).move_to(UP * 0.45)

        def note(s, anchor):
            return label(s.get("note") or "", 30).next_to(anchor, DOWN, buff=0.55)

        cur = formula(steps[0])
        nt = note(steps[0], cur)
        self.play(Write(cur), FadeIn(nt), run_time=run)
        self.wait(hold(per - run))
        for s in steps[1:]:
            nxt = formula(s)
            nn = note(s, nxt)
            self.play(TransformMatchingShapes(cur, nxt), FadeTransform(nt, nn), run_time=run)
            self.wait(hold(per - run))
            cur, nt = nxt, nn


class FunctionTransform(Scene):
    def construct(self):
        (x0, x1), (y0, y1) = P["xRange"], P["yRange"]
        step = lambda a, b: max(1, round((b - a) / 8))
        ax = Axes(
            x_range=[x0, x1, step(x0, x1)],
            y_range=[y0, y1, step(y0, y1)],
            x_length=FW * 0.86,
            y_length=FH * 0.78,
            tips=False,
            axis_config={"color": LINE, "stroke_width": 2, "include_numbers": True, "font_size": 26, "decimal_number_config": {"color": MUTED, "num_decimal_places": 0}},
        ).move_to(ORIGIN)

        def curve(points, color):
            # 超出纵向范围或无定义的点断开，避免竖线和出界
            group, run = VGroup(), []
            for x, y in points:
                if y is None or (isinstance(y, float) and math.isnan(y)) or y < y0 or y > y1:
                    if len(run) > 1:
                        group.add(VMobject(stroke_color=color, stroke_width=5).set_points_smoothly([ax.c2p(*p) for p in run]))
                    run = []
                else:
                    run.append((x, y))
            if len(run) > 1:
                group.add(VMobject(stroke_color=color, stroke_width=5).set_points_smoothly([ax.c2p(*p) for p in run]))
            return group

        stages = P["stages"]
        per = (DUR - 0.8) / len(stages)
        run = min(1.6, per * 0.6)
        self.play(Create(ax), run_time=0.8)
        cur = curve(stages[0]["points"], ACCENT)
        tag = label(stages[0]["label"], 30, INK).to_corner(UL, buff=0.3)
        self.play(Create(cur), FadeIn(tag), run_time=run)
        self.wait(hold(per - run))
        for i, s in enumerate(stages[1:], 1):
            ghost = cur.copy().set_stroke(opacity=0.25)
            nxt = curve(s["points"], ACCENT2 if i == len(stages) - 1 else ACCENT)
            nt = label(s["label"], 30, INK).to_corner(UL, buff=0.3)
            self.add(ghost)
            self.play(Transform(cur, nxt), FadeTransform(tag, nt), run_time=run)
            tag = nt
            self.wait(hold(per - run))


class NumberLineScene(Scene):
    def construct(self):
        a, b = P["range"]
        nl = NumberLine(x_range=[a, b, max(1, round((b - a) / 10))], length=FW * 0.86, color=INK, include_numbers=True, font_size=28, numbers_to_exclude=[]).move_to(DOWN * 0.9)
        nl.numbers.set_color(MUTED)
        items = len(P["intervals"]) + len(P["points"])
        per = (DUR - 1.0) / max(1, items)
        run = min(1.2, per * 0.6)
        self.play(Create(nl), run_time=1.0)
        colors = [ACCENT, ACCENT2, ACCENT, ACCENT2]
        for i, iv in enumerate(P["intervals"]):
            lo = a if iv["from"] is None else iv["from"]
            hi = b if iv["to"] is None else iv["to"]
            y = 0.45 + 0.62 * i
            c = colors[i % len(colors)]
            seg = Line(nl.n2p(lo) + UP * y, nl.n2p(hi) + UP * y, color=c, stroke_width=10)
            ends = VGroup()
            for v, closed, open_end in ((lo, iv["closedFrom"], iv["from"] is None), (hi, iv["closedTo"], iv["to"] is None)):
                if open_end:
                    continue
                d = Dot(nl.n2p(v) + UP * y, radius=0.1, color=c)
                if not closed:
                    d.set_fill(C["paper"], opacity=1).set_stroke(c, width=4)
                ends.add(d)
            tag = label(iv.get("label") or "", 28, c).next_to(seg, UP, buff=0.14, aligned_edge=LEFT).shift(RIGHT * 0.2)
            self.play(Create(seg), FadeIn(ends), FadeIn(tag), run_time=run)
            self.wait(hold(per - run))
        for p in P["points"]:
            d = Dot(nl.n2p(p["x"]), radius=0.09, color=INK)
            tag = label(p.get("label") or "", 24, INK).next_to(d, DOWN, buff=0.5)
            self.play(GrowFromCenter(d), FadeIn(tag), run_time=run)
            self.wait(hold(per - run))


class Geometry(Scene):
    def construct(self):
        g = P["graph"]
        xmin, xmax, ymin, ymax = g.get("view", [-6, 6, -4, 4])
        s = min(FW * 0.88 / (xmax - xmin), FH * 0.86 / (ymax - ymin))
        cx, cy = (xmin + xmax) / 2, (ymin + ymax) / 2

        def at(x, y):
            return RIGHT * (x - cx) * s + UP * (y - cy) * s

        pts, lines, objs = {}, {}, []
        for e in g["elements"]:
            t = e["type"]
            c = ACCENT if not e.get("color") else ACCENT2
            name = e.get("label") or ""
            if t in ("point", "midpoint"):
                if t == "point":
                    pts[e["id"]] = at(e["x"], e["y"])
                else:
                    a, b = (pts[i] for i in e["of"])
                    pts[e["id"]] = (a + b) / 2
                m = VGroup(Dot(pts[e["id"]], radius=0.07, color=INK), label(name or e["id"], 26, INK).next_to(pts[e["id"]], UP + RIGHT, buff=0.08))
            elif t in ("segment", "line"):
                a, b = pts[e["from"]], pts[e["to"]]
                lines[e["id"]] = (a, b)
                m = Line(a, b, color=c, stroke_width=4)
                if t == "line":
                    m.scale(4)
            elif t == "circle":
                center = pts[e["center"]]
                r = e["radius"] * s if e.get("radius") else float(((pts[e["through"]] - center) ** 2).sum() ** 0.5)
                m = Circle(radius=r, color=c, stroke_width=4).move_to(center)
            elif t == "polygon":
                m = Polygon(*[pts[i] for i in e["points"]], color=c, stroke_width=4).set_fill(c, opacity=0.1)
            elif t == "angle":
                a, b, d = (pts[i] for i in e["points"])
                m = Angle(Line(b, a), Line(b, d), radius=0.5, color=ACCENT2, stroke_width=4)
            elif t in ("perpendicular", "parallel"):
                a, b = lines[e["line"]]
                v = b - a
                if t == "perpendicular":
                    v = v[[1, 0, 2]] * [-1, 1, 0]
                p = pts[e["through"]]
                n = v / (sum(v**2) ** 0.5 or 1)
                m = Line(p - n * FW, p + n * FW, color=MUTED, stroke_width=3)
                lines[e["id"]] = (p, p + n)
            else:
                continue
            objs.append(m)
        per = (DUR - 0.4) / max(1, len(objs))
        run = min(1.0, per * 0.7)
        for m in objs:
            self.play(Create(m), run_time=run)
            self.wait(hold(per - run))


SCENES = {"derivation": Derivation, "function-transform": FunctionTransform, "number-line": NumberLineScene, "geometry": Geometry}
