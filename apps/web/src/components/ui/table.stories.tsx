import type { Story } from "@ladle/react";

import { Section, StoryPage } from "@/stories/_lib";

import { Badge } from "./badge";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "./table";

const ROWS = [
  { invoice: "INV001", status: "paid", method: "Credit card", amount: "$250.00" },
  { invoice: "INV002", status: "pending", method: "PayPal", amount: "$150.00" },
  { invoice: "INV003", status: "unpaid", method: "Bank transfer", amount: "$350.00" },
  { invoice: "INV004", status: "paid", method: "Credit card", amount: "$450.00" },
];

export default {
  title: "Components / Table",
};

export const All: Story = () => (
  <StoryPage
    title="Table"
    description="Static data table primitive. For sorted/filtered/paginated tables, compose with TanStack Table."
  >
    <Section title="Basic">
      <Table>
        <TableCaption>A list of recent invoices.</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[120px]">Invoice</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Method</TableHead>
            <TableHead className="text-right">Amount</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {ROWS.map((row) => (
            <TableRow key={row.invoice}>
              <TableCell className="font-medium">{row.invoice}</TableCell>
              <TableCell>
                <Badge
                  variant={
                    row.status === "paid"
                      ? "success"
                      : row.status === "pending"
                        ? "warning"
                        : "destructive"
                  }
                >
                  {row.status}
                </Badge>
              </TableCell>
              <TableCell>{row.method}</TableCell>
              <TableCell className="text-right">{row.amount}</TableCell>
            </TableRow>
          ))}
        </TableBody>
        <TableFooter>
          <TableRow>
            <TableCell colSpan={3}>Total</TableCell>
            <TableCell className="text-right">$1,200.00</TableCell>
          </TableRow>
        </TableFooter>
      </Table>
    </Section>
  </StoryPage>
);
