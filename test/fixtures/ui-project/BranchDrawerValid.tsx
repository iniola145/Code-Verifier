import { useState } from "react";
import { branchFormSchema, type BranchFormData } from "./index";
import { BranchEditTab } from "./BranchEditTab";

export function BranchDrawerValid({ onCreate, onClose }: any) {
  const [formData] = useState<BranchFormData>({
    name: "",
    address: "",
    area: "",
    phone: "",
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const handleSave = async () => {
    const result = branchFormSchema.safeParse(formData);
    if (!result.success) {
      setErrors({ form: result.error.message });
      return;
    }
    await onCreate(result.data);
    onClose();
  };
  return <BranchEditTab formData={formData} errors={errors} />;
}
