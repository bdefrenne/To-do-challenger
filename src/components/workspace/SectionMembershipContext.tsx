"use client";

/**
 * Who shows what, for one canvas — computed once per task/node change by
 * CanvasEditor and read by every Section.
 *
 * It lives in a context rather than a per-Section hook because the resolution is
 * whole-canvas by nature: a pin only counts if the node is on THIS canvas, and
 * an unpinned task falls through to its board's INBOX lane, so no Section can
 * work out its own contents in isolation. Computing it once is also what keeps
 * this O(tasks + nodes) instead of O(sections × tasks).
 */

import { createContext, useContext } from "react";
import { EMPTY_MEMBERSHIP, type SectionMembership } from "@/lib/sections";

const SectionMembershipContext = createContext<SectionMembership>(EMPTY_MEMBERSHIP);

export const SectionMembershipProvider = SectionMembershipContext.Provider;

/** This canvas's membership index. Defaults to empty outside a canvas (the
 *  board views don't resolve sections at all). */
export const useSectionMembership = (): SectionMembership =>
  useContext(SectionMembershipContext);
