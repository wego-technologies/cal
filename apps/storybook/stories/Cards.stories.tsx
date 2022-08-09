import { ComponentMeta } from "@storybook/react";

import { BaseCardProps, Card } from "@calcom/ui/v2/Card";

export default {
  title: "Cards",
  component: Card,
} as ComponentMeta<typeof Card>;

const profileProps: BaseCardProps[] = [
  {
    variant: "ProfileCard",
    title: "Alex Fisher",
    image:
      "https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?ixlib=rb-1.2.1&ixid=eyJhcHBfaWQiOjEyMDd9&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80",
    description: "Co-founder at Attio. Book a meeting to discuss enterprise deals.",
  },
  {
    variant: "ProfileCard",
    title: "Julian Wan",
    image:
      "https://images.unsplash.com/photo-1570295999919-56ceb5ecca61?ixlib=rb-1.2.1&ixid=MnwxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8&auto=format&fit=crop&w=1760&q=80",
    description: "Co-founder at Attio. Book a meeting to discuss enterprise deals.",
  },
];

export const Profile = () => {
  return (
    <div className="flex w-full space-x-2 bg-gray-200 p-4">
      <Card {...profileProps[0]} />
      <Card {...profileProps[1]} />
    </div>
  );
};

const appStoreProps: BaseCardProps = {
  variant: "AppStore",
  title: "Giphy",
  image: "https://app.cal.com/api/app-store/giphy/icon.svg",
  description: "Add GIFs to spice up your booking confirmations.",
  actionButton: {
    href: "#",
    child: "View Details",
  },
};

export const AppStore = () => {
  return (
    <div className="w-full bg-gray-200 p-4">
      <Card {...appStoreProps} />
    </div>
  );
};
