package com.example.shop;

import jakarta.servlet.http.HttpServletRequest;
import java.util.List;
import org.springframework.data.domain.Pageable;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestMethod;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class OrderController {

    @GetMapping("/api/orders")
    public List<Order> list(Pageable pageable) {
        return List.of();
    }

    @RequestMapping(value = "/api/orders/ping", method = RequestMethod.GET)
    public String ping() {
        return "pong";
    }

    @GetMapping("/files/**")
    public String file(HttpServletRequest request) {
        return request.getRequestURI();
    }
}
