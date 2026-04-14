import { LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useNavigate } from "react-router";
import { signOut } from "@/lib/auth-client";
import { MobileNavTrigger } from "@/components/sidebar";

export function Header() {
  const navigate = useNavigate();

  async function handleLogout() {
    await signOut();
    navigate("/login");
  }

  return (
    <header className="flex h-14 items-center justify-between gap-2 border-b px-4 md:px-6">
      <div className="md:hidden">
        <MobileNavTrigger />
      </div>
      <div className="hidden md:block" />
      <Button variant="ghost" size="sm" onClick={handleLogout}>
        <LogOut className="mr-2 h-4 w-4" />
        <span className="hidden sm:inline">Logout</span>
      </Button>
    </header>
  );
}
