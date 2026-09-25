import { useState } from "react";
import type { BranchFormData } from "./index";
import { BranchEditTab } from "./BranchEditTab";

export function BranchDrawer({ onCreate, onClose }: any) {
  const [formData] = useState<BranchFormData>({ name: "", address: "", area: "", phone: "" });
  const handleSave = () => {
    if (!formData.name.trim()) return;
    onCreate(formData);
    onClose();
  };
  return <BranchEditTab formData={formData} />;
}
