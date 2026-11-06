import { useEffect } from "react";
import { useSettings } from "./queries";

/** Sets the browser tab title to "<title> · <agent name>". Null leaves it to another component. */
export function usePageTitle(title: string | null): void {
  const agentName = useSettings().data?.agentName ?? "Talorys";
  useEffect(() => {
    if (title !== null) document.title = `${title} · ${agentName}`;
  }, [title, agentName]);
}
