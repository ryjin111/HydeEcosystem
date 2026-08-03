import { NavLink, useLocation } from "react-router-dom";
import type { ReactNode } from "react";

type RailItem = {
  label: string;
  to: string;
  icon: "home" | "launch" | "discover" | "mine" | "profile" | "stats";
  active: (pathname: string, search: string) => boolean;
};

const SECTIONS: { label: string; items: RailItem[] }[] = [
  {
    label: "Protocol",
    items: [
      { label: "Home", to: "/", icon: "home", active: (path) => path === "/" },
      {
        label: "Launch a Token",
        to: "/launchpad?tab=launch",
        icon: "launch",
        active: (path, search) => {
          const tab = new URLSearchParams(search).get("tab");
          return path.startsWith("/launchpad") && tab !== "mine" && tab !== "explore";
        },
      },
      {
        label: "Discover",
        to: "/discover",
        icon: "discover",
        active: (path) => path.startsWith("/discover") || path.startsWith("/token/"),
      },
    ],
  },
  {
    label: "Account",
    items: [
      {
        label: "My Launches",
        to: "/launchpad?tab=mine",
        icon: "mine",
        active: (path, search) => {
          const tab = new URLSearchParams(search).get("tab");
          return path.startsWith("/launchpad") && (tab === "mine" || tab === "explore");
        },
      },
      { label: "Portfolio", to: "/profile", icon: "profile", active: (path) => path.startsWith("/profile") },
      { label: "Stats", to: "/stats", icon: "stats", active: (path) => path.startsWith("/stats") },
    ],
  },
];

function RailIcon({ name }: { name: RailItem["icon"] }) {
  const paths: Record<RailItem["icon"], ReactNode> = {
    home: <path d="M3.5 10.5 12 3l8.5 7.5M5.5 9.5V21h13V9.5M9.5 21v-7h5v7" />,
    launch: <path d="M13.5 4.5c3.5-1.2 5.7-.7 6-.4.3.3.8 2.5-.4 6l-5.3 5.3-5.2-5.2 4.9-5.7ZM8.6 10.2 5.2 11 3 14l5.5.8M13.8 15.4 13 18.8 10 21l-.8-5.5M14.8 8.7h.01M5 19l-2 2" />,
    discover: <path d="M12 3a9 9 0 1 0 9 9 9 9 0 0 0-9-9Zm3.5 5.5-2 5-5 2 2-5 5-2Z" />,
    mine: <path d="M4 6.5h16M6.5 3.5h11l2.5 3v13H4v-13l2.5-3ZM8 11h8M8 15h5" />,
    profile: <path d="M12 12a4 4 0 1 0-4-4 4 4 0 0 0 4 4Zm7 9a7 7 0 0 0-14 0" />,
    stats: <path d="M4 20V10h4v10H4Zm6 0V4h4v16h-4Zm6 0v-7h4v7h-4Z" />,
  };
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}

function withNetwork(to: string, chainId: number): string {
  const [pathname, search = ""] = to.split("?");
  const params = new URLSearchParams(search);
  params.set("network", String(chainId));
  return `${pathname}?${params.toString()}`;
}

export function SideRail({ selectedNetworkId }: { selectedNetworkId: number }) {
  const location = useLocation();
  return (
    <aside className="hyde-side-rail hidden w-[210px] shrink-0 xl:block">
      <div className="hyde-side-rail-inner">
        <div className="side-rail-depth">
          <span className="live-ping" />
          Control trench
        </div>
        <nav aria-label="Primary">
          {SECTIONS.map((section) => (
            <div key={section.label} className="side-rail-section">
              <p>{section.label}</p>
              <div>
                {section.items.map((item) => {
                  const active = item.active(location.pathname, location.search);
                  return (
                    <NavLink
                      key={item.to}
                      to={withNetwork(item.to, selectedNetworkId)}
                      aria-current={active ? "page" : undefined}
                      className={`side-rail-button ${active ? "side-rail-button-active" : ""}`}
                    >
                      <span><RailIcon name={item.icon} /></span>
                      {item.label}
                    </NavLink>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>
        <div className="side-rail-lock">
          <strong>Move in silence.</strong>
          <span>Engine and fee routes stay visible before every action.</span>
        </div>
      </div>
    </aside>
  );
}
