import { Link } from "react-router";

export default function NotFound() {
  return (
    <main className="min-h-screen flex items-center justify-center p-8">
      <div className="space-y-4">
        <h1 className="text-2xl font-bold">404</h1>
        <Link className="text-sm underline" to="/">
          Home
        </Link>
      </div>
    </main>
  );
}
