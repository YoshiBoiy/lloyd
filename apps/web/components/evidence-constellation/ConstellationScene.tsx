"use client";
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { Canvas, useThree, useFrame } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { Color, InstancedMesh, Object3D, Vector3, type Material } from "three";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import type { ExploreGraph } from "../../../../packages/ask/src/contracts";
const palette = ["#387786", "#b58a35", "#815e9b", "#477954", "#b24e56"];
function Scene({
  graph,
  selected,
  onSelect,
  onHover,
  reset,
}: {
  graph: ExploreGraph;
  selected?: string;
  onSelect: (id: string, pin: boolean) => void;
  onHover: (text: string) => void;
  reset: number;
}) {
  const mesh = useRef<InstancedMesh>(null),
    halos = useRef<InstancedMesh>(null);
  const { camera, invalidate, size } = useThree();
  const pulse = useRef(0),
    previous = useRef(new Map<string, Vector3>()),
    transition = useRef(1);
  const scale = useMemo(
    () =>
      2.5 /
      Math.max(
        0.15,
        ...graph.nodes.flatMap((n) => [
          Math.abs(n.x),
          Math.abs(n.y),
          Math.abs(n.z),
        ]),
      ),
    [graph],
  );
  const target = useMemo(() => {
    const n = graph.nodes.find((n) => n.id === selected);
    return new Vector3(
      n ? n.x * scale : 0,
      n ? n.y * scale : 0,
      n ? n.z * scale : 0,
    );
  }, [graph, selected, scale]);
  const lines = useMemo(() => {
    const groups = new Map<
      string,
      { points: number[]; width: number; dashed: boolean }
    >();
    for (const e of graph.edges.slice(0, 300)) {
      const a = graph.nodes.find((n) => n.id === e.source),
        b = graph.nodes.find((n) => n.id === e.target);
      if (!a || !b) continue;
      const width =
          e.relationship === "QUERY_MATCH"
            ? 1
            : 1 + Math.floor(Math.max(0, e.score ?? 0) * 3),
        dashed = e.relationship === "PROVENANCE";
      const key = `${width}:${dashed}`;
      const group = groups.get(key) ?? { points: [], width, dashed };
      group.points.push(
        a.x * scale,
        a.y * scale,
        a.z * scale,
        b.x * scale,
        b.y * scale,
        b.z * scale,
      );
      groups.set(key, group);
    }
    return [...groups.values()].map((g) => {
      const geometry = new LineSegmentsGeometry();
      geometry.setPositions(g.points);
      const material = new LineMaterial({
        color: "#719dac",
        linewidth: g.width,
        dashed: g.dashed,
        dashSize: 0.1,
        gapSize: 0.06,
        transparent: true,
        opacity: 0.45,
      });
      const object = new LineSegments2(geometry, material);
      object.computeLineDistances();
      return object;
    });
  }, [graph, scale]);
  useEffect(() => {
    for (const line of lines)
      line.material.resolution.set(size.width, size.height);
    invalidate();
  }, [lines, size, invalidate]);
  useEffect(
    () => () => {
      for (const line of lines) {
        line.geometry.dispose();
        line.material.dispose();
      }
    },
    [lines],
  );
  useLayoutEffect(() => {
    transition.current = 0;
    pulse.current = 0;
    const o = new Object3D();
    graph.nodes.slice(0, 150).forEach((n, i) => {
      o.position.set(n.x * scale, n.y * scale, n.z * scale);
      o.scale.setScalar(0.07 + Math.max(0, n.relevance) * 0.08);
      o.updateMatrix();
      mesh.current?.setMatrixAt(i, o.matrix);
      mesh.current?.setColorAt(
        i,
        new Color(
          n.id === selected
            ? "#efb840"
            : n.type === "anchor"
              ? "#d1efff"
              : palette[
                  Math.abs(
                    [...n.type].reduce((s, c) => s + c.charCodeAt(0), 0),
                  ) % palette.length
                ],
        ),
      );
    });
    if (mesh.current) {
      mesh.current.instanceMatrix.needsUpdate = true;
      if (mesh.current.instanceColor)
        mesh.current.instanceColor.needsUpdate = true;
      (mesh.current.material as Material).needsUpdate = true;
      mesh.current.computeBoundingSphere();
    }
    invalidate();
  }, [graph, selected, scale, invalidate]);
  useFrame((_, delta) => {
    pulse.current += delta;
    transition.current = Math.min(1, transition.current + delta * 3);
    const o = new Object3D();
    graph.nodes.forEach((n, i) => {
      const end = new Vector3(n.x * scale, n.y * scale, n.z * scale),
        start = previous.current.get(n.id) ?? end;
      const p = start.clone().lerp(end, transition.current);
      o.position.copy(p);
      const radius = 0.07 + Math.max(0, n.relevance) * 0.08;
      o.scale.setScalar(radius);
      o.updateMatrix();
      mesh.current?.setMatrixAt(i, o.matrix);
      o.scale.setScalar(
        n.cited || n.id === selected
          ? radius *
              (1.5 +
                (n.id === selected && pulse.current < 1.5
                  ? 0.15 * Math.sin(pulse.current * 10)
                  : 0))
          : 0,
      );
      o.updateMatrix();
      halos.current?.setMatrixAt(i, o.matrix);
      if (transition.current === 1) previous.current.set(n.id, end);
    });
    if (mesh.current) mesh.current.instanceMatrix.needsUpdate = true;
    if (halos.current) halos.current.instanceMatrix.needsUpdate = true;
    if (transition.current < 1 || pulse.current < 1.5) invalidate();
  });
  useEffect(() => {
    camera.position.copy(target).add(new Vector3(4, 3, 7));
    camera.lookAt(target);
    invalidate();
  }, [target, reset, camera, invalidate]);
  return (
    <>
      <ambientLight intensity={0.8} />
      <directionalLight position={[3, 4, 5]} intensity={1.5} />
      <instancedMesh
        ref={mesh}
        args={[undefined, undefined, graph.nodes.length]}
        frustumCulled={false}
        onClick={(e) => {
          e.stopPropagation();
          const n = graph.nodes[e.instanceId ?? -1];
          if (n && n.type !== "anchor") onSelect(n.id, e.nativeEvent.shiftKey);
        }}
        onPointerMove={(e) => {
          const n = graph.nodes[e.instanceId ?? -1];
          if (n)
            onHover(
              `${n.label} · ${n.type} · score ${n.relevance.toFixed(3)} · ${n.metadataPreview.verificationStatus ?? n.metadataPreview.missingDimensions ?? "query match"}`,
            );
        }}
        onPointerOut={() => onHover("")}
      >
        <sphereGeometry args={[1, 16, 12]} />
        <meshStandardMaterial />
      </instancedMesh>
      <instancedMesh
        ref={halos}
        args={[undefined, undefined, graph.nodes.length]}
        frustumCulled={false}
      >
        <sphereGeometry args={[1, 12, 8]} />
        <meshBasicMaterial
          color="#e8bd63"
          wireframe
          transparent
          opacity={0.45}
        />
      </instancedMesh>
      {lines.map((line, i) => (
        <primitive key={i} object={line} />
      ))}
      <OrbitControls makeDefault target={target} enableDamping={false} />
    </>
  );
}
export default function ConstellationScene(props: {
  graph: ExploreGraph;
  selected?: string;
  onSelect: (id: string, pin: boolean) => void;
  onHover: (text: string) => void;
  onFailure: () => void;
  reset: number;
}) {
  return (
    <div
      className="h-[460px] rounded-lg bg-[#112c3b]"
      role="img"
      aria-label="Interactive evidence constellation; use the ranked list for keyboard navigation"
    >
      <Canvas
        frameloop="demand"
        camera={{ position: [4, 3, 7], fov: 50 }}
        onCreated={({ gl }) =>
          gl.domElement.addEventListener("webglcontextlost", props.onFailure, {
            once: true,
          })
        }
      >
        <Scene {...props} />
      </Canvas>
    </div>
  );
}
