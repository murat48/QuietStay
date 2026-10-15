import type { ReactNode, SVGProps } from "react";

type IconName = "stay" | "shield" | "listing" | "transfer" | "lock" | "arrow" | "check";
const paths: Record<IconName, ReactNode> = {
  stay: <><path d="m3 11 9-7 9 7M6 10v9h12v-9M10 19v-6h4v6" /><path d="M3 22c3-2 6 2 9 0s6 2 9 0" /></>,
  shield: <><path d="M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6l-8-3Z" /><path d="m8.5 12 2.5 2.5 4.5-5" /></>,
  listing: <><rect x="5" y="4" width="14" height="17" rx="2" /><path d="M9 4V2m6 2V2M9 9h6m-6 4h6m-6 4h3" /></>,
  transfer: <><path d="M4 7h16m-5-5 5 5-5 5M20 17H4m5-5-5 5 5 5" /></>,
  lock: <><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2" /></>,
  arrow: <path d="M4 12h16m-6-6 6 6-6 6" />,
  check: <path d="m5 12 4 4L19 6" />,
};

export function Icon({ name, ...props }: SVGProps<SVGSVGElement> & { name: IconName }) {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      {paths[name]}
    </svg>
  );
}
