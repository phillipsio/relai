import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-semibold transition-colors",
  {
    variants: {
      variant: {
        default:     "border-transparent bg-zinc-700 text-zinc-100",
        green:       "border-transparent bg-green-900 text-green-300",
        yellow:      "border-transparent bg-yellow-900 text-yellow-300",
        red:         "border-transparent bg-red-900 text-red-300",
        blue:        "border-transparent bg-blue-900 text-blue-300",
        outline:     "border-zinc-600 text-zinc-400",
      },
    },
    defaultVariants: { variant: "default" },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}
