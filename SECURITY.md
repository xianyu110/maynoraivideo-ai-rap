# Security policy

## Reporting a vulnerability

Please report security problems privately. Don't put them in public issues, pull requests or discussions.

1. Open this repository's **Security and quality** tab and click **Report a vulnerability** ([GitHub's guide](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)).
2. Include the affected route or file, steps to reproduce, and the impact you expect.

If the button isn't there, open an issue that only asks for a private contact, without any details of the problem.

This is a template maintained in spare time, so there is no guaranteed response time. Fixes go to the latest `main`; older commits aren't patched.

## Scope

In scope: the code and configuration in this repository.

Out of scope:

- Sites built from this template. Report those to the site's operator.
- Third-party services the template integrates with (Cloudflare, Google, TryAllAPI, Waffo, Dodo Payments, Stripe, OpenAI).
- Problems that only occur when a deployment skips the production settings in the README, such as `APP_ENV` not set to `production`. If the code is supposed to refuse a setting but doesn't, that is in scope.

## Running a site from this template

Production secrets, `APP_ENV`, `ADMIN_EMAILS` and the other settings under [Deploying to Cloudflare](README.md#deploying-to-cloudflare) are the operator's responsibility. Merge template updates regularly (see [Merging template updates into a site](README.md#merging-template-updates-into-a-site)) so security fixes reach your site.
