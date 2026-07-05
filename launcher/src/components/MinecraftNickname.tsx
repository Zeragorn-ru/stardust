import type { Badge, Gradient } from "../types";
import { getBadgeIcon } from "../badge-icons";

interface Props {
  name: string;
  badge?: Pick<Badge, "emoji" | "color"> | null;
  gradient?: Pick<Gradient, "colorStart" | "colorEnd"> | null;
  className?: string;
}

export default function MinecraftNickname({ name, badge, gradient, className }: Props) {
  const gradientStyle = gradient
    ? {
        background: `linear-gradient(90deg, ${gradient.colorStart}, ${gradient.colorEnd})`,
        WebkitBackgroundClip: "text",
        WebkitTextFillColor: "transparent",
      }
    : undefined;

  const badgeSvg = badge ? getBadgeIcon(badge.emoji) : null;

  return (
    <span className={"minecraft-nick" + (className ? ` ${className}` : "")}>
      {badge && (
        <span className="minecraft-nick__badge" style={{ color: badge.color }}>
          {badgeSvg ? (
            <span
              className="minecraft-nick__badge-icon"
              dangerouslySetInnerHTML={{ __html: badgeSvg }}
            />
          ) : (
            badge.emoji
          )}
        </span>
      )}
      <span className="minecraft-nick__name-wrap">
        <span className="minecraft-nick__name-shadow" aria-hidden="true">
          {name}
        </span>
        <span className="minecraft-nick__name" style={gradientStyle}>
          {name}
        </span>
      </span>
    </span>
  );
}
