/** @jsxImportSource @opentui/solid */
import type { ModelAxis } from "../model-axes.js";
import type { AxisSelection } from "./axis-state.js";
import { formatSelection } from "./axis-state.js";

export function StatusWidget(props: { axes: () => ModelAxis[]; selection: () => AxisSelection }) {
  const label = () => {
    const axes = props.axes();
    if (axes.length === 0) return "";
    return formatSelection(axes, props.selection());
  };
  return <text>{label()}</text>;
}
