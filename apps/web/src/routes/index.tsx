import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  component: HomeComponent,
});

function HomeComponent() {
  return (
    <main className="p-8">
      <h1 className="text-2xl font-semibold">AdCP web app</h1>
      <p className="mt-2 text-sm text-gray-600">
        Stage 0 scaffold. shadcn primitives + Ladle stories arrive in the next PR.
      </p>
    </main>
  );
}
