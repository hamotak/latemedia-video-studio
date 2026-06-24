"use client";

import * as React from "react";
import { useEffect } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  /** Extra classes for the dialog panel (e.g. a wider max-width). */
  className?: string;
  children: React.ReactNode;
}

/**
 * Shared centered pop-up. Backdrop + Esc close, scrollable body. Used for the
 * Video/B-Rolls history overlays and any future studio dialogs.
 */
export function Modal({ open, onClose, title, className, children }: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
      />
      <section
        role="dialog"
        aria-modal="true"
        className={cn(
          "relative z-10 flex max-h-[calc(100vh-4rem)] w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-border/80 bg-card shadow-2xl shadow-black/40",
          className
        )}
      >
        <div className="flex items-center justify-between gap-3 border-b border-border/70 bg-background/40 px-4 py-3">
          <h2 className="text-sm font-semibold">{title}</h2>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="h-8 w-8"
            onClick={onClose}
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="overflow-y-auto">{children}</div>
      </section>
    </div>
  );
}
