import type { RepoOverlay } from '../types';
import { springPom } from './common';

/** keybank/CIF00/customer-profile-api: Spring Boot 3, system of record for customer profiles. */
export const CIF_REPO = 'keybank/CIF00/customer-profile-api';

const PKG = 'src/main/java/com/keybank/cif';
const TEST = 'src/test/java/com/keybank/cif';

export const CIF_PATHS = {
  applicationYml: 'src/main/resources/application.yml',
  controller: `${PKG}/api/CustomerProfileController.java`,
  profileDto: `${PKG}/api/dto/CustomerProfileResponse.java`,
  requestLogging: `${PKG}/api/RequestLoggingFilter.java`,
  security: `${PKG}/config/SecurityConfig.java`,
  service: `${PKG}/service/CustomerProfileService.java`,
  controllerTest: `${TEST}/api/CustomerProfileControllerTest.java`,
  profileFixture: 'src/test/resources/fixtures/customer-profile-C10458213.json',
  baselineMigration: 'src/main/resources/db/migration/V1__baseline.sql',
} as const;

export const CIF_APPLICATION_YML = `server:
  port: 8080
  shutdown: graceful
  forward-headers-strategy: framework

spring:
  application:
    name: customer-profile-api
  lifecycle:
    timeout-per-shutdown-phase: 20s
  datasource:
    url: jdbc:postgresql://cif-pg-prod.internal.keybank.example:5432/cif
    username: \${CIF_DB_USER}
    password: \${CIF_DB_PASSWORD}
    hikari:
      maximum-pool-size: 30
      minimum-idle: 10
      connection-timeout: 5000
  jpa:
    open-in-view: false
    hibernate:
      ddl-auto: validate
  flyway:
    enabled: true
    locations: classpath:db/migration
  jackson:
    property-naming-strategy: LOWER_CAMEL_CASE
    default-property-inclusion: non_null
    serialization:
      write-dates-as-timestamps: false
    deserialization:
      fail-on-unknown-properties: false
  security:
    oauth2:
      resourceserver:
        jwt:
          issuer-uri: https://auth.internal.keybank.example
          jwk-set-uri: https://auth.internal.keybank.example/.well-known/jwks.json
          audiences: keybank-apis

management:
  server:
    port: 8081
  endpoints:
    web:
      exposure:
        include: health,info,prometheus
  endpoint:
    health:
      probes:
        enabled: true

logging:
  structured:
    format:
      console: logstash
  level:
    root: INFO
    com.keybank.cif: INFO
`;

const APPLICATION = `package com.keybank.cif;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class CustomerProfileApplication {

  public static void main(String[] args) {
    SpringApplication.run(CustomerProfileApplication.class, args);
  }
}
`;

export const CIF_CONTROLLER = `package com.keybank.cif.api;

import com.keybank.cif.api.dto.CustomerProfileResponse;
import com.keybank.cif.api.dto.RelationshipResponse;
import com.keybank.cif.service.CustomerProfileService;
import jakarta.validation.constraints.Pattern;
import java.util.List;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Customer profile API. Consumed by OLB, MBL, PAY, DEP, CRD, TLR, FRD, NTF, BPY and ~170 other
 * internal applications.
 */
@Validated
@RestController
@RequestMapping("/v1/customers")
public class CustomerProfileController {

  private static final String CUSTOMER_ID = "C\\\\d{8}";

  private final CustomerProfileService service;

  public CustomerProfileController(CustomerProfileService service) {
    this.service = service;
  }

  @GetMapping("/{customerId}/profile")
  public CustomerProfileResponse getProfile(
      @PathVariable @Pattern(regexp = CUSTOMER_ID) String customerId) {
    return service.getProfile(customerId);
  }

  @GetMapping("/{customerId}/relationships")
  public List<RelationshipResponse> getRelationships(
      @PathVariable @Pattern(regexp = CUSTOMER_ID) String customerId) {
    return service.getRelationships(customerId);
  }
}
`;

export const CIF_PROFILE_DTO = `package com.keybank.cif.api.dto;

import java.time.LocalDate;
import java.time.OffsetDateTime;

/** Response body of GET /v1/customers/{customerId}/profile. */
public record CustomerProfileResponse(
    String customerId,
    String firstName,
    String lastName,
    LocalDate dateOfBirth,
    String primaryEmail,
    String mobilePhone,
    Address mailingAddress,
    String segment,
    String kycStatus,
    String riskRating,
    ContactPreferences contactPreferences,
    OffsetDateTime customerSince,
    OffsetDateTime lastUpdated) {

  public record Address(
      String line1, String line2, String city, String state, String postalCode) {}

  public record ContactPreferences(
      boolean email, boolean sms, boolean push, String preferredChannel) {}
}
`;

const RELATIONSHIP_DTO = `package com.keybank.cif.api.dto;

/** One customer-to-account relationship. Account numbers are always masked. */
public record RelationshipResponse(
    String accountNumberMasked, String productCode, String role, String status) {}
`;

const EXCEPTION_HANDLER = `package com.keybank.cif.api;

import com.keybank.cif.service.CustomerProfileService.CustomerNotFoundException;
import jakarta.validation.ConstraintViolationException;
import org.springframework.http.HttpStatus;
import org.springframework.http.ProblemDetail;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

@RestControllerAdvice
public class ApiExceptionHandler {

  @ExceptionHandler(CustomerNotFoundException.class)
  ProblemDetail notFound(CustomerNotFoundException ex) {
    ProblemDetail problem = ProblemDetail.forStatusAndDetail(HttpStatus.NOT_FOUND, ex.getMessage());
    problem.setTitle("Customer not found");
    return problem;
  }

  @ExceptionHandler(ConstraintViolationException.class)
  ProblemDetail badRequest(ConstraintViolationException ex) {
    ProblemDetail problem = ProblemDetail.forStatusAndDetail(HttpStatus.BAD_REQUEST, ex.getMessage());
    problem.setTitle("Invalid customer id");
    return problem;
  }
}
`;

export const CIF_REQUEST_LOGGING = `package com.keybank.cif.api;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

/** One INFO line per API request: method, path, status, duration and calling OAuth client. */
@Component
public class RequestLoggingFilter extends OncePerRequestFilter {

  private static final Logger log = LoggerFactory.getLogger(RequestLoggingFilter.class);

  @Override
  protected void doFilterInternal(
      HttpServletRequest request, HttpServletResponse response, FilterChain chain)
      throws ServletException, IOException {
    long start = System.nanoTime();
    try {
      chain.doFilter(request, response);
    } finally {
      long tookMs = (System.nanoTime() - start) / 1_000_000;
      log.info(
          "{} {} {} {}ms client_id={}",
          request.getMethod(),
          request.getRequestURI(),
          response.getStatus(),
          tookMs,
          clientId());
    }
  }

  @Override
  protected boolean shouldNotFilter(HttpServletRequest request) {
    return request.getRequestURI().startsWith("/actuator");
  }

  private static String clientId() {
    Authentication auth = SecurityContextHolder.getContext().getAuthentication();
    if (auth instanceof JwtAuthenticationToken jwt) {
      return jwt.getToken().getClaimAsString("azp");
    }
    return "-";
  }
}
`;

export const CIF_SECURITY = `package com.keybank.cif.config;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpMethod;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.oauth2.server.resource.web.BearerTokenAuthenticationEntryPoint;
import org.springframework.security.web.AuthenticationEntryPoint;
import org.springframework.security.web.SecurityFilterChain;

@Configuration
@EnableWebSecurity
public class SecurityConfig {

  private static final Logger log = LoggerFactory.getLogger(SecurityConfig.class);

  @Bean
  SecurityFilterChain api(HttpSecurity http) throws Exception {
    http.csrf(csrf -> csrf.disable())
        .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
        .authorizeHttpRequests(
            auth ->
                auth.requestMatchers("/actuator/health/**")
                    .permitAll()
                    .requestMatchers(HttpMethod.GET, "/v1/customers/**")
                    .hasAuthority("SCOPE_cif.read")
                    .anyRequest()
                    .authenticated())
        .oauth2ResourceServer(
            oauth -> oauth.jwt(Customizer.withDefaults()).authenticationEntryPoint(entryPoint()));
    return http.build();
  }

  /** Standard RFC 6750 401, plus a WARN line so rejected callers show up in the logs. */
  private static AuthenticationEntryPoint entryPoint() {
    BearerTokenAuthenticationEntryPoint delegate = new BearerTokenAuthenticationEntryPoint();
    return (request, response, ex) -> {
      log.warn(
          "Rejected bearer token: {} {} -> 401 invalid_token: {}",
          request.getMethod(),
          request.getRequestURI(),
          ex.getMessage());
      delegate.commence(request, response, ex);
    };
  }
}
`;

const CUSTOMER_ENTITY = `package com.keybank.cif.domain;

import jakarta.persistence.CollectionTable;
import jakarta.persistence.Column;
import jakarta.persistence.ElementCollection;
import jakarta.persistence.Embeddable;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.JoinColumn;
import jakarta.persistence.Table;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.List;

@Entity
@Table(name = "customer")
public class Customer {

  @Id
  @Column(length = 12)
  private String customerId;

  private String firstName;
  private String lastName;
  private LocalDate dateOfBirth;
  private String primaryEmail;
  private String mobilePhone;

  private String addressLine1;
  private String addressLine2;
  private String city;
  private String state;
  private String postalCode;

  private String segment;
  private String kycStatus;
  private String riskRating;

  private boolean emailOptIn;
  private boolean smsOptIn;
  private boolean pushOptIn;
  private String preferredChannel;

  private OffsetDateTime customerSince;
  private OffsetDateTime lastUpdated;

  @ElementCollection
  @CollectionTable(name = "customer_relationship", joinColumns = @JoinColumn(name = "customer_id"))
  private List<Relationship> relationships = new ArrayList<>();

  protected Customer() {}

  public String getCustomerId() { return customerId; }
  public String getFirstName() { return firstName; }
  public String getLastName() { return lastName; }
  public LocalDate getDateOfBirth() { return dateOfBirth; }
  public String getPrimaryEmail() { return primaryEmail; }
  public String getMobilePhone() { return mobilePhone; }
  public String getAddressLine1() { return addressLine1; }
  public String getAddressLine2() { return addressLine2; }
  public String getCity() { return city; }
  public String getState() { return state; }
  public String getPostalCode() { return postalCode; }
  public String getSegment() { return segment; }
  public String getKycStatus() { return kycStatus; }
  public String getRiskRating() { return riskRating; }
  public boolean isEmailOptIn() { return emailOptIn; }
  public boolean isSmsOptIn() { return smsOptIn; }
  public boolean isPushOptIn() { return pushOptIn; }
  public String getPreferredChannel() { return preferredChannel; }
  public OffsetDateTime getCustomerSince() { return customerSince; }
  public OffsetDateTime getLastUpdated() { return lastUpdated; }
  public List<Relationship> getRelationships() { return relationships; }

  @Embeddable
  public static class Relationship {
    private String accountNumber;
    private String productCode;
    private String role;
    private String status;

    public String getAccountNumber() { return accountNumber; }
    public String getProductCode() { return productCode; }
    public String getRole() { return role; }
    public String getStatus() { return status; }
  }
}
`;

const CUSTOMER_REPOSITORY = `package com.keybank.cif.domain;

import org.springframework.data.jpa.repository.JpaRepository;

public interface CustomerRepository extends JpaRepository<Customer, String> {}
`;

export const CIF_SERVICE = `package com.keybank.cif.service;

import com.keybank.cif.api.dto.CustomerProfileResponse;
import com.keybank.cif.api.dto.CustomerProfileResponse.Address;
import com.keybank.cif.api.dto.CustomerProfileResponse.ContactPreferences;
import com.keybank.cif.api.dto.RelationshipResponse;
import com.keybank.cif.domain.Customer;
import com.keybank.cif.domain.CustomerRepository;
import java.util.List;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
@Transactional(readOnly = true)
public class CustomerProfileService {

  private final CustomerRepository customers;

  public CustomerProfileService(CustomerRepository customers) {
    this.customers = customers;
  }

  public CustomerProfileResponse getProfile(String customerId) {
    Customer c = find(customerId);
    return new CustomerProfileResponse(
        c.getCustomerId(),
        c.getFirstName(),
        c.getLastName(),
        c.getDateOfBirth(),
        c.getPrimaryEmail(),
        c.getMobilePhone(),
        new Address(
            c.getAddressLine1(), c.getAddressLine2(), c.getCity(), c.getState(), c.getPostalCode()),
        c.getSegment(),
        c.getKycStatus(),
        c.getRiskRating(),
        new ContactPreferences(
            c.isEmailOptIn(), c.isSmsOptIn(), c.isPushOptIn(), c.getPreferredChannel()),
        c.getCustomerSince(),
        c.getLastUpdated());
  }

  public List<RelationshipResponse> getRelationships(String customerId) {
    return find(customerId).getRelationships().stream()
        .map(
            r ->
                new RelationshipResponse(
                    mask(r.getAccountNumber()), r.getProductCode(), r.getRole(), r.getStatus()))
        .toList();
  }

  private Customer find(String customerId) {
    return customers
        .findById(customerId)
        .orElseThrow(() -> new CustomerNotFoundException(customerId));
  }

  static String mask(String accountNumber) {
    return "****" + accountNumber.substring(Math.max(0, accountNumber.length() - 4));
  }

  public static class CustomerNotFoundException extends RuntimeException {
    public CustomerNotFoundException(String customerId) {
      super("Customer not found: " + customerId);
    }
  }
}
`;

const BASELINE_MIGRATION = `create table customer (
  customer_id        varchar(12)  primary key,
  first_name         varchar(80)  not null,
  last_name          varchar(80)  not null,
  date_of_birth      date,
  primary_email      varchar(254),
  mobile_phone       varchar(20),
  address_line1      varchar(120),
  address_line2      varchar(120),
  city               varchar(80),
  state              char(2),
  postal_code        varchar(10),
  segment            varchar(20)  not null,
  kyc_status         varchar(20)  not null,
  risk_rating        varchar(10),
  email_opt_in       boolean      not null default true,
  sms_opt_in         boolean      not null default false,
  push_opt_in        boolean      not null default false,
  preferred_channel  varchar(10)  not null default 'EMAIL',
  customer_since     timestamptz  not null,
  last_updated       timestamptz  not null
);

create table customer_relationship (
  customer_id     varchar(12) not null references customer (customer_id),
  account_number  varchar(17) not null,
  product_code    varchar(10) not null,
  role            varchar(20) not null,
  status          varchar(10) not null
);

create index customer_relationship_customer_idx on customer_relationship (customer_id);
`;

/** The jsonPath assertions the bad MR rewrites to snake_case. */
export const CIF_TEST_ASSERTIONS_CAMEL = `        .andExpect(jsonPath("$.customerId").value("C10458213"))
        .andExpect(jsonPath("$.firstName").value("Jordan"))
        .andExpect(jsonPath("$.kycStatus").value("VERIFIED"))
        .andExpect(jsonPath("$.contactPreferences.preferredChannel").value("EMAIL"))`;

export const CIF_TEST_ASSERTIONS_SNAKE = `        .andExpect(jsonPath("$.customer_id").value("C10458213"))
        .andExpect(jsonPath("$.first_name").value("Jordan"))
        .andExpect(jsonPath("$.kyc_status").value("VERIFIED"))
        .andExpect(jsonPath("$.contact_preferences.preferred_channel").value("EMAIL"))`;

const CONTROLLER_TEST = `package com.keybank.cif.api;

import static org.mockito.Mockito.when;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.jwt;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.keybank.cif.api.dto.CustomerProfileResponse;
import com.keybank.cif.api.dto.CustomerProfileResponse.Address;
import com.keybank.cif.api.dto.CustomerProfileResponse.ContactPreferences;
import com.keybank.cif.config.SecurityConfig;
import com.keybank.cif.service.CustomerProfileService;
import com.keybank.cif.service.CustomerProfileService.CustomerNotFoundException;
import java.nio.charset.StandardCharsets;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.context.annotation.Import;
import org.springframework.core.io.ClassPathResource;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;

@WebMvcTest(CustomerProfileController.class)
@Import(SecurityConfig.class)
class CustomerProfileControllerTest {

  @Autowired MockMvc mvc;

  @MockitoBean CustomerProfileService service;

  @Test
  void returnsProfile() throws Exception {
    when(service.getProfile("C10458213")).thenReturn(profile());

    mvc.perform(get("/v1/customers/C10458213/profile").with(cifReader()))
        .andExpect(status().isOk())
${CIF_TEST_ASSERTIONS_CAMEL}
        .andExpect(content().json(fixture("fixtures/customer-profile-C10458213.json"), true));
  }

  @Test
  void unknownCustomerIs404() throws Exception {
    when(service.getProfile("C99999999")).thenThrow(new CustomerNotFoundException("C99999999"));

    mvc.perform(get("/v1/customers/C99999999/profile").with(cifReader()))
        .andExpect(status().isNotFound());
  }

  @Test
  void requiresCifReadScope() throws Exception {
    mvc.perform(get("/v1/customers/C10458213/profile").with(jwt()))
        .andExpect(status().isForbidden());
  }

  private static org.springframework.test.web.servlet.request.RequestPostProcessor cifReader() {
    return jwt().authorities(new SimpleGrantedAuthority("SCOPE_cif.read"));
  }

  private static CustomerProfileResponse profile() {
    return new CustomerProfileResponse(
        "C10458213",
        "Jordan",
        "Ellis",
        LocalDate.parse("1984-06-02"),
        "jordan.ellis@example.com",
        "+1-216-555-0142",
        new Address("1200 Euclid Ave", null, "Cleveland", "OH", "44115"),
        "RETAIL",
        "VERIFIED",
        "LOW",
        new ContactPreferences(true, true, false, "EMAIL"),
        OffsetDateTime.parse("2011-03-14T00:00:00Z"),
        OffsetDateTime.parse("2026-10-28T14:12:09Z"));
  }

  private static String fixture(String path) throws Exception {
    return new ClassPathResource(path).getContentAsString(StandardCharsets.UTF_8);
  }
}
`;

export const CIF_FIXTURE_CAMEL = `{
  "customerId": "C10458213",
  "firstName": "Jordan",
  "lastName": "Ellis",
  "dateOfBirth": "1984-06-02",
  "primaryEmail": "jordan.ellis@example.com",
  "mobilePhone": "+1-216-555-0142",
  "mailingAddress": {
    "line1": "1200 Euclid Ave",
    "city": "Cleveland",
    "state": "OH",
    "postalCode": "44115"
  },
  "segment": "RETAIL",
  "kycStatus": "VERIFIED",
  "riskRating": "LOW",
  "contactPreferences": {
    "email": true,
    "sms": true,
    "push": false,
    "preferredChannel": "EMAIL"
  },
  "customerSince": "2011-03-14T00:00:00Z",
  "lastUpdated": "2026-10-28T14:12:09Z"
}
`;

export const CIF_FIXTURE_SNAKE = `{
  "customer_id": "C10458213",
  "first_name": "Jordan",
  "last_name": "Ellis",
  "date_of_birth": "1984-06-02",
  "primary_email": "jordan.ellis@example.com",
  "mobile_phone": "+1-216-555-0142",
  "mailing_address": {
    "line1": "1200 Euclid Ave",
    "city": "Cleveland",
    "state": "OH",
    "postal_code": "44115"
  },
  "segment": "RETAIL",
  "kyc_status": "VERIFIED",
  "risk_rating": "LOW",
  "contact_preferences": {
    "email": true,
    "sms": true,
    "push": false,
    "preferred_channel": "EMAIL"
  },
  "customer_since": "2011-03-14T00:00:00Z",
  "last_updated": "2026-10-28T14:12:09Z"
}
`;

/** Top-level keys CIF returns once SNAKE_CASE is live (what consumers log as `receivedKeys`). */
export const CIF_SNAKE_KEYS = [
  'customer_id',
  'first_name',
  'last_name',
  'date_of_birth',
  'primary_email',
  'mobile_phone',
  'mailing_address',
  'segment',
  'kyc_status',
  'risk_rating',
  'contact_preferences',
  'customer_since',
  'last_updated',
];

export const cifOverlay: RepoOverlay = {
  complete: true,
  files: {
    'pom.xml': springPom({
      tla: 'CIF',
      artifactId: 'customer-profile-api',
      version: '2.14.0',
      description: 'CIF customer profile and relationship API',
    }),
    [CIF_PATHS.applicationYml]: CIF_APPLICATION_YML,
    [`${PKG}/CustomerProfileApplication.java`]: APPLICATION,
    [CIF_PATHS.controller]: CIF_CONTROLLER,
    [CIF_PATHS.profileDto]: CIF_PROFILE_DTO,
    [`${PKG}/api/dto/RelationshipResponse.java`]: RELATIONSHIP_DTO,
    [`${PKG}/api/ApiExceptionHandler.java`]: EXCEPTION_HANDLER,
    [CIF_PATHS.requestLogging]: CIF_REQUEST_LOGGING,
    [CIF_PATHS.security]: CIF_SECURITY,
    [`${PKG}/domain/Customer.java`]: CUSTOMER_ENTITY,
    [`${PKG}/domain/CustomerRepository.java`]: CUSTOMER_REPOSITORY,
    [CIF_PATHS.service]: CIF_SERVICE,
    [CIF_PATHS.baselineMigration]: BASELINE_MIGRATION,
    [CIF_PATHS.controllerTest]: CONTROLLER_TEST,
    [CIF_PATHS.profileFixture]: CIF_FIXTURE_CAMEL,
  },
};
