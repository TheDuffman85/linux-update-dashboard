type BadgeVariant = "success" | "warning" | "danger" | "info" | "muted";

const variantStyles: Record<BadgeVariant, string> = {
  success: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
  warning: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
  danger: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
  info: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
  muted: "bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300",
};

export function Badge({
  children,
  variant = "muted",
  small = false,
}: {
  children: React.ReactNode;
  variant?: BadgeVariant;
  small?: boolean;
}) {
  return (
    <span
      className={`inline-flex items-center rounded-full font-medium ${variantStyles[variant]} ${
        small ? "px-1.5 py-0.5 text-[10px]" : "px-2.5 py-0.5 text-xs"
      }`}
    >
      {children}
    </span>
  );
}
