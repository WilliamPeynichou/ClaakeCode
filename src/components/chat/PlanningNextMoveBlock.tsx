import { DotmSquare5 } from "./DotmSquare5";
import { Claaky } from "../claaky/Claaky";
import { useClaakyEnabled } from "../claaky/useClaakyEnabled";

export function PlanningNextMoveBlock() {
  const claakyOn = useClaakyEnabled();
  return (
    <div className="thinking-block planning-next-move" role="status">
      <div
        className="thinking-block__head planning-next-move__head"
        data-streaming="true"
        data-has-content="false"
      >
        {claakyOn ? (
          <Claaky state="planning" size={26} className="claaky-loader" decorative />
        ) : (
          <DotmSquare5
            speed={1}
            animated
            className="thinking-block__matrix planning-next-move__matrix"
          />
        )}
        <span className="thinking-block__label" data-streaming="true">
          Planning next moves
        </span>
      </div>
    </div>
  );
}
