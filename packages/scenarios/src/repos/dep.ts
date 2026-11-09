import type { RepoOverlay } from '../types';

/** keybank/DEP00/deposit-accounts-api: checking/savings accounts, balances and holds. */
export const DEP_REPO = 'keybank/DEP00/deposit-accounts-api';

const PKG = 'src/main/java/com/keybank/dep';

export const DEP_PATHS = {
  profileClient: `${PKG}/client/CustomerProfileClient.java`,
  ownership: `${PKG}/service/AccountOwnershipService.java`,
  controller: `${PKG}/api/AccountBalanceController.java`,
} as const;

const PROFILE_CLIENT = `package com.keybank.dep.client;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

/** CIF customer-profile-api client. */
@Component
public class CustomerProfileClient {

  public record CustomerProfile(String customerId, String firstName, String lastName, String kycStatus) {}

  private final RestClient http;

  public CustomerProfileClient(
      RestClient.Builder builder, @Value("\${deposits.clients.cif-base-url}") String baseUrl) {
    this.http = builder.baseUrl(baseUrl).build();
  }

  public CustomerProfile getProfile(String customerId) {
    return http.get()
        .uri("/v1/customers/{customerId}/profile", customerId)
        .retrieve()
        .body(CustomerProfile.class);
  }
}
`;

export const DEP_OWNERSHIP = `package com.keybank.dep.service;

import com.keybank.dep.client.CustomerProfileClient;
import com.keybank.dep.client.CustomerProfileClient.CustomerProfile;
import java.util.Objects;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

/** Account ownership checks, resolved against the CIF customer of record. */
@Service
public class AccountOwnershipService {

  private final CustomerProfileClient profiles;
  private final JdbcTemplate jdbc;

  public AccountOwnershipService(CustomerProfileClient profiles, JdbcTemplate jdbc) {
    this.profiles = profiles;
    this.jdbc = jdbc;
  }

  /** True when the customer is an owner or joint owner of the account. */
  public boolean isOwner(String customerId, String accountNumber) {
    CustomerProfile profile = profiles.getProfile(customerId);
    String cifCustomerId = Objects.requireNonNull(profile.customerId(), "CIF profile.customerId");
    Integer owners =
        jdbc.queryForObject(
            "select count(*) from account_owner where account_number = ? and customer_id = ?",
            Integer.class,
            accountNumber,
            cifCustomerId);
    return owners != null && owners > 0;
  }
}
`;

export const DEP_CONTROLLER = `package com.keybank.dep.api;

import com.keybank.dep.service.AccountOwnershipService;
import java.math.BigDecimal;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

@RestController
@RequestMapping("/v1/accounts")
public class AccountBalanceController {

  private final AccountOwnershipService ownership;
  private final JdbcTemplate jdbc;

  public AccountBalanceController(AccountOwnershipService ownership, JdbcTemplate jdbc) {
    this.ownership = ownership;
    this.jdbc = jdbc;
  }

  public record Balances(String accountNumber, BigDecimal ledger, BigDecimal available, BigDecimal holds) {}

  @GetMapping("/{accountNumber}/balances")
  public Balances balances(@PathVariable String accountNumber, @AuthenticationPrincipal Jwt jwt) {
    if (!ownership.isOwner(jwt.getSubject(), accountNumber)) {
      throw new ResponseStatusException(HttpStatus.FORBIDDEN);
    }
    Map<String, Object> row =
        jdbc.queryForMap(
            "select ledger_balance, available_balance, hold_amount from account_balance where account_number = ?",
            accountNumber);
    return new Balances(
        "****" + accountNumber.substring(accountNumber.length() - 4),
        (BigDecimal) row.get("ledger_balance"),
        (BigDecimal) row.get("available_balance"),
        (BigDecimal) row.get("hold_amount"));
  }
}
`;

export const depOverlay: RepoOverlay = {
  complete: false,
  files: {
    [DEP_PATHS.profileClient]: PROFILE_CLIENT,
    [DEP_PATHS.ownership]: DEP_OWNERSHIP,
    [DEP_PATHS.controller]: DEP_CONTROLLER,
  },
};
