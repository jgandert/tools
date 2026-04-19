(function(window) {
    // Use global paper if available (for non-module environments)
    const paper = window.paper || (typeof require !== "undefined" ? require("paper") : null);

    if (!paper) {
        console.error("shapebuilder.js: paper.js not found. Please load paper.js first.");
    }

    // Create a headless project if there isn't one.

    // Expected to be run in Browser or Node (if paper-core is used).
    if (!paper.project) {
        if (typeof window !== "undefined" && typeof document !== "undefined") {
            const canvas = document.createElement("canvas");
            canvas.width = 1000;
            canvas.height = 1000;
            paper.setup(canvas);
        } else {
            // Headless Node environment
            paper.setup(new paper.Size(1000, 1000));
        }
    }

    // CompoundPath utilities for methods that only exist on Path
    function getPathOffsetOf(path, point) {
        if (typeof path.getNearestLocation === "function") {
            const loc = path.getNearestLocation(point);
            // In boolean intersections and cuts, the resulting path drift can be enormous compared to the abstract point.
            // As long as the mathematical engine returns a location associated with this layout, return it.
            if (loc) {
                return loc.offset;
            }
        }
        if (typeof path.getOffsetOf === "function") {
            return path.getOffsetOf(point);
        } else if (path.children) {
            let offset = 0;
            for (const child of path.children) {
                const childOffset = child.getOffsetOf(point);
                if (childOffset !== null && childOffset !== undefined) {
                    return offset + childOffset;
                }
                offset += child.length;
            }
        }
        return null;
    }

    function getPathPointAt(path, offset) {
        if (typeof path.getPointAt === "function") {
            return path.getPointAt(offset);
        } else if (path.children) {
            let currentOffset = 0;
            for (const child of path.children) {
                if (offset <= currentOffset + child.length) {
                    return child.getPointAt(offset - currentOffset);
                }
                currentOffset += child.length;
            }
        }
        return null;
    }

    function getPathNormalAt(path, offset) {
        if (typeof path.getNormalAt === "function") {
            return path.getNormalAt(offset);
        } else if (path.children) {
            let currentOffset = 0;
            for (const child of path.children) {
                if (offset <= currentOffset + child.length) {
                    return child.getNormalAt(offset - currentOffset);
                }
                currentOffset += child.length;
            }
        }
        return null;
    }

    class PointWrapper {
        constructor(x, y, pathContext, offsetContext) {
            if (x instanceof paper.Point) {
                this.p = x;
            } else if (x && typeof x === "object" && x.p instanceof paper.Point) {
                this.p = x.p.clone();
                this.pathContext = x.pathContext;
                this.offsetContext = x.offsetContext;
            } else if (Array.isArray(x)) {
                this.p = new paper.Point(x[0], x[1]);
            } else if (typeof x === "object" && "x" in x) {
                this.p = new paper.Point(x.x, x.y);
            } else {
                this.p = new paper.Point(x || 0, y || 0);
            }
            if (pathContext !== undefined) {
                this.pathContext = pathContext;
            }
            if (offsetContext !== undefined) {
                this.offsetContext = offsetContext;
            }
        }

        get x() {
            return this.p.x;
        }

        get y() {
            return this.p.y;
        }

        movePerpendicular({ amount, direction, path, offset }) {
            const targetPath = path || this.pathContext;
            if (!targetPath) {
                throw new Error("movePerpendicular requires a shape or path reference.");
            }
            const paperPath = targetPath.path || targetPath;
            let actualOffset = offset !== undefined ? offset : this.offsetContext;
            if (actualOffset === undefined) {
                actualOffset = getPathOffsetOf(paperPath, this.p);
            }
            if (actualOffset === null || actualOffset === undefined) {
                throw new Error("Point is not on the given shaping path.");
            }
            const normal = getPathNormalAt(paperPath, actualOffset);

            let moveVec = normal.multiply(amount);
            if (direction === "inward") {
                moveVec = moveVec.multiply(-1);
            }
            return new PointWrapper(this.p.add(moveVec)); // Returns point off-path
        }

        static interpolate({ pt1, pt2, percent }) {
            const p1 = new PointWrapper(pt1).p;
            const p2 = new PointWrapper(pt2).p;
            const diff = p2.subtract(p1);
            return new PointWrapper(p1.add(diff.multiply(percent)));
        }
    }

    class Shape {
        constructor(paperPath, initialPoints = {}) {
            this.path = paperPath;
            // Do not render to the active view automatically
            if (paperPath.project) {
                paperPath.remove();
            }
            this.points = initialPoints;
            this.updateBoundingPoints();
        }

        clone() {
            const pointsClone = {};
            for (const [k, v] of Object.entries(this.points)) {
                pointsClone[k] = new PointWrapper(v.p.clone());
            }
            return new Shape(this.path.clone(), pointsClone);
        }

        updateBoundingPoints() {
            const b = this.path.bounds;
            this.points.top = new PointWrapper(b.topCenter);
            this.points.bottom = new PointWrapper(b.bottomCenter);
            this.points.left = new PointWrapper(b.leftCenter);
            this.points.right = new PointWrapper(b.rightCenter);
            this.points.center = new PointWrapper(b.center);

            this.center = this.points.center;
            this.bounds = {
                top: b.top,
                bottom: b.bottom,
                left: b.left,
                right: b.right,
                width: b.width,
                height: b.height,
                center: [b.center.x, b.center.y],
            };
        }

        static inheritPoints(newPath, parents) {
            const newPoints = {};

            function getNearest(path, pt) {
                if (typeof path.getNearestLocation === "function") {
                    const loc = path.getNearestLocation(pt);
                    return loc ? loc.point : null;
                } else if (typeof path.getNearestPoint === "function") {
                    return path.getNearestPoint(pt);
                } else if (path.children) {
                    let closest = null;
                    let minDist = Infinity;
                    for (const child of path.children) {
                        const childNearest = getNearest(child, pt);
                        if (childNearest) {
                            const d = childNearest.getDistance(pt);
                            if (d < minDist) {
                                minDist = d;
                                closest = childNearest;
                            }
                        }
                    }
                    return closest;
                }
                return null;
            }

            for (const parent of parents) {
                for (const [name, pt] of Object.entries(parent.points)) {
                    // Approximate point location check on the new perimeter
                    const nearest = getNearest(newPath, pt.p);
                    if (nearest && nearest.getDistance(pt.p) < 0.1) {
                        newPoints[name] = pt;
                    }
                }
            }
            return newPoints;
        }

        union({ shapes }) {
            let resultPath = this.path;
            const allShapes = [this, ...shapes];
            for (const shape of shapes) {
                resultPath = resultPath.unite(shape.path);
            }
            return new Shape(resultPath, Shape.inheritPoints(resultPath, allShapes));
        }

        subtract({ shapes }) {
            let resultPath = this.path;
            const allShapes = [this, ...shapes];
            for (const shape of shapes) {
                resultPath = resultPath.subtract(shape.path);
            }
            return new Shape(resultPath, Shape.inheritPoints(resultPath, allShapes));
        }

        intersect({ shapes }) {
            let resultPath = this.path;
            const allShapes = [this, ...shapes];
            for (const shape of shapes) {
                resultPath = resultPath.intersect(shape.path);
            }
            return new Shape(resultPath, Shape.inheritPoints(resultPath, allShapes));
        }

        intersectBounding(other) {
            return this.intersect({ shapes: [other] });
        }

        xor({ shapes }) {
            let resultPath = this.path;
            const allShapes = [this, ...shapes];
            for (const shape of shapes) {
                resultPath = resultPath.exclude(shape.path);
            }
            return new Shape(resultPath, Shape.inheritPoints(resultPath, allShapes));
        }

        stretch({ width, height, preserveWidth, preserveHeight }) {
            const b = this.path.bounds;
            const sx = preserveWidth ? 1 : (width !== undefined ? width / b.width : 1);
            const sy = preserveHeight ? 1 : (height !== undefined ? height / b.height : 1);
            this.path.scale(sx, sy, b.center);

            for (const pt of Object.values(this.points)) {
                const dx = (pt.x - b.center.x) * sx;
                const dy = (pt.y - b.center.y) * sy;
                pt.p.x = b.center.x + dx;
                pt.p.y = b.center.y + dy;
            }
            this.updateBoundingPoints();
            return this;
        }

        scale({ factor, center }) {
            const c = center ? new PointWrapper(center).p : this.path.bounds.center;
            this.path.scale(factor, c);
            for (const pt of Object.values(this.points)) {
                const dx = (pt.x - c.x) * factor;
                const dy = (pt.y - c.y) * factor;
                pt.p.x = c.x + dx;
                pt.p.y = c.y + dy;
            }
            this.updateBoundingPoints();
            return this;
        }

        rotate({ angle, center }) {
            const c = center ? new PointWrapper(center).p : this.path.bounds.center;
            this.path.rotate(angle, c);
            for (const pt of Object.values(this.points)) {
                pt.p = pt.p.rotate(angle, c);
            }
            this.updateBoundingPoints();
            return this;
        }

        translate({ dx = 0, dy = 0 }) {
            const vec = new paper.Point(dx, dy);
            this.path.translate(vec);
            for (const pt of Object.values(this.points)) {
                pt.p = pt.p.add(vec);
            }
            this.updateBoundingPoints();
            return this;
        }

        moveUntil({ direction, step = 1, condition }) {
            const vec = new paper.Point(direction[0], direction[1]).normalize().multiply(step);
            let maxIter = 10000;
            while (!condition(this) && maxIter-- > 0) {
                this.path.translate(vec);
                for (const pt of Object.values(this.points)) {
                    pt.p = pt.p.add(vec);
                }
                this.updateBoundingPoints();
            }
            return this;
        }

        slideDirection({ vector, stopAt }) {
            return this.moveUntil({
                direction: vector,
                step: 1,
                condition: (self) => self.path.intersects(stopAt.path),
            });
        }

        offset({ amount, join }) {
            console.warn("Offset implementation uses simple scaling. Recommend native paper.js offset if available.");
            const sx = (this.bounds.width + 2 * amount) / this.bounds.width;
            const sy = (this.bounds.height + 2 * amount) / this.bounds.height;
            return this.clone().stretch({
                width: this.bounds.width * sx,
                height: this.bounds.height * sy,
            });
        }

        roundCorners({ radius }) {
            const newPath = this.path.clone();
            newPath.smooth({ type: "geometric", factor: radius / 10 });
            return new Shape(newPath, this.points);
        }

        getPointOnPath({ from, to, percent }) {
            const p1 = new PointWrapper(this.points[from] || from).p;
            const p2 = new PointWrapper(this.points[to] || to).p;

            const off1 = getPathOffsetOf(this.path, p1);
            let off2 = getPathOffsetOf(this.path, p2);

            if (off1 === null || off2 === null) {
                // Highly forgiving fallback just retrieving via points if offset is not mathematically perfectly on the generated curve
                // This typically happens if the bounding boxes drifted after boolean unions / slicing
                if (off1 === null) {
                    console.warn("from point offset on outline drift:", p1);
                }
                if (off2 === null) {
                    console.warn("to point offset on outline drift:", p2);
                }
                throw new Error("Points must be closely on the shape outline.");
            }

            const pathLength = this.path.length;
            if (off2 < off1) {
                off2 += pathLength;
            }

            let targetOff = off1 + (off2 - off1) * percent;
            targetOff = targetOff % pathLength;

            const pt = getPathPointAt(this.path, targetOff);
            return new PointWrapper(pt, undefined, this, targetOff);
        }

        sliceByPoints({ p1, p2 }) {
            const pt1 = new PointWrapper(p1).p;
            const pt2 = new PointWrapper(p2).p;
            return new Slicer(this, pt1, pt2);
        }

        sliceByLine({ lineShape }) {
            // Line should be a simple Path.Line equivalent
            let p1, p2;
            if (lineShape.path.segments.length >= 2) {
                p1 = lineShape.path.segments[0].point;
                p2 = lineShape.path.segments[lineShape.path.segments.length - 1].point;
            } else {
                // Find bounding box diagonal or just midpoints roughly
                p1 = lineShape.path.bounds.topLeft;
                p2 = lineShape.path.bounds.bottomRight;
            }
            return new Slicer(this, p1, p2);
        }

        snapPoints({ map }) {
            if (!map || map.length === 0) {
                return this;
            }

            const from1Pt = (typeof map[0].from === "string" ? this.points[map[0].from] : map[0].from).p;
            const to1Pt = new PointWrapper(map[0].to).p;

            const dx = to1Pt.x - from1Pt.x;
            const dy = to1Pt.y - from1Pt.y;
            this.translate({ dx, dy });

            if (map.length > 1) {
                // Need to fetch from2Pt AFTER translation!
                const from2Pt = (typeof map[1].from === "string" ? this.points[map[1].from] : map[1].from).p;
                const to2Pt = new PointWrapper(map[1].to).p;

                // vFrom is vector from the mapped from1 point (which is now resting natively on to1Pt!) to the new translated from2
                const vFrom = from2Pt.subtract(to1Pt);
                // vTo is the target vector between the two map points
                const vTo = to2Pt.subtract(to1Pt);

                const angle = vTo.angle - vFrom.angle;
                this.rotate({ angle, center: to1Pt });
            }
            return this;
        }

        distributePoints({ count, paddingMode }) {
            const points = [];
            const len = this.path.length;
            if (count === 1) {
                points.push(new PointWrapper(getPathPointAt(this.path, len / 2)));
                return points;
            }

            if (paddingMode === "space-evenly") {
                const step = len / (count + 1);
                for (let i = 1; i <= count; i++) {
                    points.push(new PointWrapper(getPathPointAt(this.path, step * i)));
                }
            } else {
                const step = len / (count - 1);
                for (let i = 0; i < count; i++) {
                    points.push(new PointWrapper(getPathPointAt(this.path, step * i)));
                }
            }
            return points;
        }

        mirror({ axis, about }) {
            const c = about === "center" ? this.bounds.center : new PointWrapper(about).p;
            const mirrored = this.clone();
            if (axis === "vertical") {
                mirrored.path.scale(-1, 1, c);
                for (const pt of Object.values(mirrored.points)) {
                    pt.p.x = c.x - (pt.p.x - c.x);
                }
            } else {
                mirrored.path.scale(1, -1, c);
                for (const pt of Object.values(mirrored.points)) {
                    pt.p.y = c.y - (pt.p.y - c.y);
                }
            }
            mirrored.updateBoundingPoints();
            return mirrored;
        }

        split({ angle, center, gap }) {
            const c = new PointWrapper(center).p;
            const w = 10000;
            const h = gap;
            const rectCutter = new paper.Path.Rectangle({
                point: [c.x - w / 2, c.y - h / 2],
                size: [w, h],
            });
            rectCutter.rotate(angle, c);

            const newPath = this.path.subtract(rectCutter);
            this.path = newPath;
            this.updateBoundingPoints();
            return this;
        }

        strokeToPath({ width, cap }) {
            console.warn("strokeToPath uses native Paper.js features when available, fallback to rectangle bounding approximation.");
            if (this.path.segments.length === 2 && cap === "round") {
                const p1 = this.path.segments[0].point;
                const p2 = this.path.segments[1].point;
                const v = p2.subtract(p1);
                const n = v.rotate(90).normalize().multiply(width / 2);

                const r = new paper.Path();
                r.add(p1.add(n));
                r.add(p2.add(n));
                r.arcTo(p2.subtract(n));
                r.add(p1.subtract(n));
                r.arcTo(p1.add(n));
                r.closed = true;
                return new Shape(r, this.points);
            }
            return this;
        }

        radialRepeat({ count, center }) {
            const c = new PointWrapper(center).p;
            let compound = new paper.CompoundPath();
            const angleStep = 360 / count;

            for (let i = 0; i < count; i++) {
                const clone = this.path.clone();
                clone.rotate(angleStep * i, c);
                compound = compound.unite(clone);
            }
            return new Shape(compound);
        }

        smooth(options = {}) {
            this.path.smooth({ type: "continuous", factor: options.tension || 0.5 });
            return this;
        }

        toSVG({ fill, stroke, strokeWidth } = {}) {
            const d = this.path.pathData;
            const attrs = [`d="${d}"`];
            if (fill) {
                attrs.push(`fill="${fill}"`);
            }
            if (stroke) {
                attrs.push(`stroke="${stroke}"`);
            }
            if (strokeWidth !== undefined) {
                attrs.push(`stroke-width="${strokeWidth}"`);
            }

            // If the resulting path doesn't explicitly close cleanly in some string reps,
            // paper.js pathData handles it natively.
            return `<path ${attrs.join(" ")} />`;
        }
    }

    class Slicer {
        constructor(shape, p1, p2) {
            this.shape = shape;
            this.p1 = p1;
            this.p2 = p2;
        }

        _buildHalfPolygons() {
            const v = this.p2.subtract(this.p1);
            const L = 10000;

            const rightNormal = v.clone().rotate(90).normalize();
            const pathRight = new paper.Path();
            pathRight.add(this.p1.subtract(v.normalize(L)));
            pathRight.add(this.p2.add(v.normalize(L)));
            pathRight.add(this.p2.add(v.normalize(L)).add(rightNormal.multiply(L)));
            pathRight.add(this.p1.subtract(v.normalize(L)).add(rightNormal.multiply(L)));
            pathRight.closed = true;

            const leftNormal = v.clone().rotate(-90).normalize();
            const pathLeft = new paper.Path();
            pathLeft.add(this.p1.subtract(v.normalize(L)));
            pathLeft.add(this.p2.add(v.normalize(L)));
            pathLeft.add(this.p2.add(v.normalize(L)).add(leftNormal.multiply(L)));
            pathLeft.add(this.p1.subtract(v.normalize(L)).add(leftNormal.multiply(L)));
            pathLeft.closed = true;

            return { pathLeft, pathRight };
        }

        keepLeft() {
            const { pathLeft } = this._buildHalfPolygons();
            return this.shape.intersect({ shapes: [new Shape(pathLeft)] });
        }

        keepRight() {
            const { pathRight } = this._buildHalfPolygons();
            return this.shape.intersect({ shapes: [new Shape(pathRight)] });
        }

        keepTop() {
            const { pathLeft, pathRight } = this._buildHalfPolygons();
            const leftBox = pathLeft.bounds;
            if (leftBox.center.y < this.p1.y) {
                return this.shape.intersect({ shapes: [new Shape(pathLeft)] });
            }
            return this.shape.intersect({ shapes: [new Shape(pathRight)] });
        }

        keepBottom() {
            const { pathLeft, pathRight } = this._buildHalfPolygons();
            const leftBox = pathLeft.bounds;
            if (leftBox.center.y >= this.p1.y) {
                return this.shape.intersect({ shapes: [new Shape(pathLeft)] });
            }
            return this.shape.intersect({ shapes: [new Shape(pathRight)] });
        }
    }

    const Builder = {
        Point: ({ x = 0, y = 0 } = {}) => {
            return new PointWrapper(x, y);
        },

        Triangle: ({ side, points }) => {
            if (points) {
                const path = new paper.Path({
                    segments: points.map(p => new PointWrapper(p).p),
                    closed: true,
                });
                const namedPoints = {
                    A: new PointWrapper(path.segments[0].point),
                    B: new PointWrapper(path.segments[1].point),
                    C: new PointWrapper(path.segments[2].point),
                };
                return new Shape(path, namedPoints);
            } else {
                const h = side * (Math.sqrt(3) / 2);
                const p1 = new paper.Point(0, -h / 2);
                const p2 = new paper.Point(side / 2, h / 2);
                const p3 = new paper.Point(-side / 2, h / 2);

                const path = new paper.Path({ segments: [p1, p2, p3], closed: true });
                return new Shape(path, {
                    A: new PointWrapper(p1),
                    B: new PointWrapper(p2),
                    C: new PointWrapper(p3),
                });
            }
        },

        Circle: ({ radius, center }) => {
            const c = center ? new PointWrapper(center).p : new paper.Point(0, 0);
            const path = new paper.Path.Circle(c, radius);
            return new Shape(path, {
                A: new PointWrapper(c.x, c.y - radius),
                B: new PointWrapper(c.x + radius, c.y),
                C: new PointWrapper(c.x, c.y + radius),
                D: new PointWrapper(c.x - radius, c.y),
            });
        },

        Rectangle: ({ width, height, center }) => {
            const c = center ? new PointWrapper(center).p : new paper.Point(0, 0);
            const path = new paper.Path.Rectangle({
                point: [c.x - width / 2, c.y - height / 2],
                size: [width, height],
            });
            return new Shape(path, {
                A: new PointWrapper(path.segments[0].point),
                B: new PointWrapper(path.segments[1].point),
                C: new PointWrapper(path.segments[2].point),
                D: new PointWrapper(path.segments[3].point),
            });
        },

        Polygon: ({ points }) => {
            const path = new paper.Path({
                segments: points.map(p => new PointWrapper(p).p),
                closed: true,
            });
            return new Shape(path);
        },

        Line: ({ start, end, angle, center, length, thickness, cap }) => {
            let p1, p2;
            if (start && end) {
                p1 = new PointWrapper(start).p;
                p2 = new PointWrapper(end).p;
            } else if (center && length !== undefined && angle !== undefined) {
                const c = new PointWrapper(center).p;
                const vector = new paper.Point({ length: length / 2, angle: angle });
                p1 = c.subtract(vector);
                p2 = c.add(vector);
            } else {
                p1 = new paper.Point(0, 0);
                p2 = new paper.Point(1, 1);
            }

            const path = new paper.Path.Line(p1, p2);
            let s = new Shape(path);
            if (thickness) {
                s = s.strokeToPath({ width: thickness, cap: cap });
            }
            return s;
        },

        Bezier: ({ points }) => {
            const path = new paper.Path({ segments: points.map(p => new PointWrapper(p).p) });
            return new Shape(path);
        },

        union: ({ shapes }) => shapes[0].union({ shapes: shapes.slice(1) }),
        subtract: ({ shapes }) => shapes[0].subtract({ shapes: shapes.slice(1) }),
        intersect: ({ shapes }) => shapes[0].intersect({ shapes: shapes.slice(1) }),
        xor: ({ shapes }) => shapes[0].xor({ shapes: shapes.slice(1) }),

        align: ({ shapes, axis, distribution, width }) => {
            if (!shapes || shapes.length === 0) {
                return;
            }
            const currentPos = 0;
            const spacing = distribution === "space-between" ? width / (shapes.length - 1 || 1) : width / shapes.length;

            for (let i = 0; i < shapes.length; i++) {
                const sh = shapes[i];
                const target = currentPos + i * spacing;

                if (axis === "horizontal") {
                    sh.translate({ dx: target - sh.bounds.center[0], dy: 0 });
                } else {
                    sh.translate({ dx: 0, dy: target - sh.bounds.center[1] });
                }
            }
        },
    };


    // Export to global scope for non-module environments
    window.ShapeBuilder = { Builder, Shape, Point: PointWrapper };
    // Also export individually for convenience
    window.Builder = Builder;
    window.Shape = Shape;
    window.Point = PointWrapper;
})(this);


