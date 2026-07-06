import type { ComponentProps } from "react";

type ButtonVariant = "default" | "secondary" | "ghost" | "destructive" | "outline";
type ButtonSize = "default" | "sm" | "icon";
type BadgeVariant = "default" | "secondary" | "success" | "destructive" | "outline" | "muted";

function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

export function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: ComponentProps<"button"> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return (
    <button
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn("sd-button", className)}
      {...props}
    />
  );
}

export function Card({ className, ...props }: ComponentProps<"section">) {
  return <section data-slot="card" className={cn("sd-card", className)} {...props} />;
}

export function CardHeader({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="card-header" className={cn("sd-card-header", className)} {...props} />;
}

export function CardTitle({ className, ...props }: ComponentProps<"h2">) {
  return <h2 data-slot="card-title" className={cn("sd-card-title", className)} {...props} />;
}

export function CardDescription({ className, ...props }: ComponentProps<"p">) {
  return <p data-slot="card-description" className={cn("sd-card-description", className)} {...props} />;
}

export function CardAction({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="card-action" className={cn("sd-card-action", className)} {...props} />;
}

export function CardContent({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="card-content" className={cn("sd-card-content", className)} {...props} />;
}

export function Badge({
  className,
  variant = "default",
  ...props
}: ComponentProps<"span"> & { variant?: BadgeVariant }) {
  return (
    <span
      data-slot="badge"
      data-variant={variant}
      className={cn("sd-badge", className)}
      {...props}
    />
  );
}

export function Table({ className, ...props }: ComponentProps<"table">) {
  return (
    <div data-slot="table-container" className="sd-table-container">
      <table data-slot="table" className={cn("sd-table", className)} {...props} />
    </div>
  );
}

export function TableHeader({ className, ...props }: ComponentProps<"thead">) {
  return <thead data-slot="table-header" className={cn("sd-table-header", className)} {...props} />;
}

export function TableBody({ className, ...props }: ComponentProps<"tbody">) {
  return <tbody data-slot="table-body" className={cn("sd-table-body", className)} {...props} />;
}

export function TableRow({ className, ...props }: ComponentProps<"tr">) {
  return <tr data-slot="table-row" className={cn("sd-table-row", className)} {...props} />;
}

export function TableHead({ className, ...props }: ComponentProps<"th">) {
  return <th data-slot="table-head" className={cn("sd-table-head", className)} {...props} />;
}

export function TableCell({ className, ...props }: ComponentProps<"td">) {
  return <td data-slot="table-cell" className={cn("sd-table-cell", className)} {...props} />;
}
