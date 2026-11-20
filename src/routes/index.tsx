import { createFileRoute } from "@tanstack/react-router";
import { VeloraApp } from "@/components/velora/app";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  return <VeloraApp />;
}
