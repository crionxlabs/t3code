/**
 * AdelisOne: the startup popup. When this computer isn't connected to a server
 * yet, the app opens this once per launch and asks for the invite link. Closing
 * it dismisses it for this launch; Settings → General keeps the same control for later.
 */
import { useEffect, useState } from "react";

import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../apps/web/src/components/ui/dialog";
import { A1AccountCard, useA1Account } from "./A1AccountCard";

export function A1ConnectDialogHost() {
  const { status } = useA1Account();
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (status && !status.registered && !dismissed) setOpen(true);
    if (status?.signedIn) setOpen(false);
  }, [status, dismissed]);

  const close = () => {
    setDismissed(true);
    setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Connect to your AdelisOne server</DialogTitle>
          <DialogDescription>
            Paste the invite link you were sent. It connects this computer to your company&rsquo;s
            AdelisOne server, which holds the data, memory, and approvals every conversation uses.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <A1AccountCard compact />
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
