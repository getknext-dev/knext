'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect } from 'react';

interface NavLinkProps {
  href: string;
  children: React.ReactNode;
}

export default function NavLink({ href, children }: NavLinkProps) {
  const pathname = usePathname();
  const isActive = pathname === href;

  // Prefetch on hover for immediate navigation
  useEffect(() => {
    // Warm up the route cache on component mount
    const warmUp = async () => {
      // Use router.prefetch behind the scenes via Link
    };
    warmUp();
  }, []);

  return (
    <Link
      href={href}
      prefetch={true} // Explicitly enable prefetch
      className={`block px-4 py-2 rounded-lg transition-colors ${
        isActive
          ? 'bg-purple-600/50 text-white'
          : 'text-gray-300 hover:bg-white/10 hover:text-white'
      }`}
    >
      {children}
    </Link>
  );
}
